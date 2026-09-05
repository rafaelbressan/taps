import { buildCycleReport, buildOpenDebtReport, formatCycleReport } from '../../src/report';
import { payoutFactor } from '../../src/minimum';
import { InMemoryPayoutStore } from '../../src/store/memory';
import { tz1 } from '../helpers/addresses';
import { buildHarness } from '../helpers/engine';
import { FakeChain } from '../helpers/fake-chain';
import { delegator, makeSplit } from '../helpers/split';

const BAKER = tz1(1);
const CYCLE = 1336;
const WHALE = tz1(201);
const SMALL = tz1(202);

/** The transfer costs the same in every test here. Only K moves. */
const TRANSFER_COST = 5_000n;

/**
 * A split built so that one delegator sits between one transfer cost and
 * three of them:
 *
 *   pool 10 000 000, no own balance, commission 5% → distributable 9 500 000
 *   SMALL holds 1/1000 of the delegated balance    → owed 9 500 mutez
 *
 * At K = 1 the cut is 5 000 and SMALL is paid. At K = 3 it is 15 000 and
 * SMALL is not. Same split, same estimated cost, different membership.
 */
function splitAroundTheCut(cycle = CYCLE) {
  return makeSplit({
    baker: BAKER,
    cycle,
    ownDelegatedBalance: 0n,
    delegatedRewards: 10_000_000n,
    delegators: [
      delegator(WHALE, 999_000_000_000n),
      delegator(SMALL, 1_000_000_000n),
    ],
  });
}

describe('the cut is K x the estimated cost (RN-24)', () => {
  it('K decides who enters the batch, with the same split and the same cost', async () => {
    const atOne = buildHarness({
      split: splitAroundTheCut(),
      feeMutez: TRANSFER_COST,
      payoutFactor: payoutFactor(1n, 1n),
    });
    const one = await atOne.engine.run(atOne.request);

    const atThree = buildHarness({
      split: splitAroundTheCut(),
      feeMutez: TRANSFER_COST,
      payoutFactor: payoutFactor(3n, 1n),
    });
    const three = await atThree.engine.run(atThree.request);

    const smallAtOne = one.lines.find((line) => line.address === SMALL)!;
    const smallAtThree = three.lines.find((line) => line.address === SMALL)!;

    expect(smallAtOne.payable).toBe(smallAtThree.payable);
    expect(smallAtOne.minimum).toBe(TRANSFER_COST);
    expect(smallAtThree.minimum).toBe(3n * TRANSFER_COST);

    // The only thing that changed is K, and it changed who was paid.
    expect(smallAtOne.paid).toBe(true);
    expect(smallAtThree.paid).toBe(false);
    expect(smallAtThree.carriedOut).toBe(smallAtOne.amount);

    // The whale clears either cut, so the batch is never empty and the
    // difference is not "K = 3 pays nobody".
    expect(one.lines.find((l) => l.address === WHALE)!.paid).toBe(true);
    expect(three.lines.find((l) => l.address === WHALE)!.paid).toBe(true);
    expect(three.totalSent).toBeLessThan(one.totalSent);
  });

  it('what the cut withheld comes back the moment it clears', async () => {
    const store = new InMemoryPayoutStore();
    // One chain across the three cycles: the branch moves between them, so
    // two cycles carrying the same amounts do not forge the same operation.
    const chain = new FakeChain();
    const factor = payoutFactor(5n, 1n);

    // Three cycles at K = 5: 9 500 owed each time against a 25 000 cut. The
    // first two accumulate to 19 000 and still do not clear it; the third
    // reaches 28 500 and pays the whole thing at once.
    for (const cycle of [CYCLE, CYCLE + 1]) {
      const harness = buildHarness({
        split: splitAroundTheCut(cycle),
        feeMutez: TRANSFER_COST,
        payoutFactor: factor,
        store,
        chain,
        headCycle: CYCLE + 10,
      });
      const result = await harness.engine.run({ ...harness.request, cycle });
      expect(result.lines.find((l) => l.address === SMALL)!.paid).toBe(false);
    }
    expect((await store.loadCarryOver(BAKER)).get(SMALL)).toBe(19_000n);

    const third = buildHarness({
      split: splitAroundTheCut(CYCLE + 2),
      feeMutez: TRANSFER_COST,
      payoutFactor: factor,
      store,
      chain,
      headCycle: CYCLE + 10,
    });
    const result = await third.engine.run({ ...third.request, cycle: CYCLE + 2 });
    const small = result.lines.find((line) => line.address === SMALL)!;

    // 9 500 x 3, to the mutez: nothing was rounded away by waiting.
    expect(small.paid).toBe(true);
    expect(small.amount).toBe(28_500n);
    expect((await store.loadCarryOver(BAKER)).get(SMALL)).toBeUndefined();
  });

  it('records K and the cost the cut came from, so a past cycle stays explainable', async () => {
    const harness = buildHarness({
      split: splitAroundTheCut(),
      feeMutez: TRANSFER_COST,
      payoutFactor: payoutFactor(3n, 1n),
    });
    await harness.engine.run(harness.request);

    const snapshot = (await harness.store.getDistribution(BAKER, CYCLE))!;
    expect(snapshot.distribution.payoutFactorNumerator).toBe(3n);
    expect(snapshot.distribution.payoutFactorDenominator).toBe(1n);

    const small = snapshot.lines.find((line) => line.address === SMALL)!;
    expect(small.transferCostMutez).toBe(TRANSFER_COST);
    // Both halves are on record, so the cut can be recomputed years later
    // from what was written and never from today's network fee.
    expect(small.minimumMutez).toBe(
      (small.transferCostMutez * snapshot.distribution.payoutFactorNumerator) /
        snapshot.distribution.payoutFactorDenominator,
    );
  });
});

describe('the report shows the delegator the cut held back (RN-24, borda 2)', () => {
  it('lists them every cycle, with what the cycle owed and the debt so far', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const factor = payoutFactor(5n, 1n);

    const first = buildHarness({
      split: splitAroundTheCut(),
      feeMutez: TRANSFER_COST,
      payoutFactor: factor,
      store,
      chain,
      headCycle: CYCLE + 10,
    });
    await first.engine.run(first.request);

    const second = buildHarness({
      split: splitAroundTheCut(CYCLE + 1),
      feeMutez: TRANSFER_COST,
      payoutFactor: factor,
      store,
      chain,
      headCycle: CYCLE + 10,
    });
    await second.engine.run({ ...second.request, cycle: CYCLE + 1 });

    const report = buildCycleReport((await store.getDistribution(BAKER, CYCLE + 1))!);

    // Nobody disappears for being small: two delegators, two rows.
    expect(report.rows).toHaveLength(2);
    expect(report.delegatorCount).toBe(2);
    expect(report.belowCutCount).toBe(1);
    expect(report.payoutFactor).toBe('5');

    const small = report.rows.find((row) => row.address === SMALL)!;
    expect(small.status).toBe('below-cut');
    expect(small.owedThisCycleMutez).toBe(9_500n);
    expect(small.carriedInMutez).toBe(9_500n);
    expect(small.cutMutez).toBe(25_000n);
    expect(small.paidMutez).toBe(0n);
    expect(small.debtMutez).toBe(19_000n);

    expect(formatCycleReport(report)).toContain(SMALL);
    expect(formatCycleReport(report)).toContain('below-cut');
  });

  it('adds up the open debt across cycles, for the human deciding to settle it', async () => {
    const harness = buildHarness({
      split: splitAroundTheCut(),
      feeMutez: TRANSFER_COST,
      payoutFactor: payoutFactor(3n, 1n),
    });
    await harness.engine.run(harness.request);

    const debt = buildOpenDebtReport(BAKER, await harness.store.loadCarryOver(BAKER));
    expect(debt.rows).toEqual([{ address: SMALL, debtMutez: 9_500n }]);
    expect(debt.totalMutez).toBe(9_500n);
  });
});
