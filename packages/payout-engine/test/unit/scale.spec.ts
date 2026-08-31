import { sumMutez } from '@tezos-suite/chain';
import { tz1 } from '../helpers/addresses';
import { buildHarness } from '../helpers/engine';
import { delegator, makeSplit } from '../helpers/split';
import { testConstants } from '../helpers/constants';

/**
 * The real case, not an edge case.
 *
 * A TzKT page holds at most 10 000 rows, and the largest baker on mainnet had
 * 60 258 delegators in cycle 1336. A client that reads one page pays the first
 * 10 000 too much and the remaining 50 258 nothing at all, and raises nothing
 * while doing it. `MAX_BATCH_SIZE = 100` would then need 603 batches where the
 * block gas ceiling allows far fewer, and every extra batch is another window
 * for a partial failure.
 */
describe('a baker with more delegators than one page holds', () => {
  const BAKER = tz1(1);
  const CYCLE = 1336;
  const COUNT = 60_258;

  it('pays every one of them, in batches sized by the block gas ceiling', async () => {
    const delegators = Array.from({ length: COUNT }, (_, index) =>
      delegator(tz1(1_000_000 + index), 1_000_000_000n),
    );
    const split = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 0n,
      delegatedRewards: BigInt(COUNT) * 10_000n,
      delegators,
    });

    const constants = testConstants();
    const harness = buildHarness({ split, constants, confirmationPolls: 6 });
    const result = await harness.engine.run(harness.request);

    expect(result.status).toBe('settled');
    const snapshot = (await harness.store.getDistribution(BAKER, CYCLE))!;
    expect(snapshot.lines).toHaveLength(COUNT);
    expect(snapshot.lines.every((line) => line.result === 'applied')).toBe(true);

    const destinations = new Set(
      snapshot.batches.flatMap((batch) => batch.transfers.map((t) => t.address)),
    );
    expect(destinations.size).toBe(COUNT);

    // Sized by accumulated gas against hard_gas_limit_per_block, so a batch is
    // hundreds of operations, not a hundred.
    const budget = (constants.hardGasLimitPerBlock * 90n) / 100n;
    for (const batch of snapshot.batches) {
      expect(batch.totalGas).toBeLessThanOrEqual(budget);
    }
    const largest = Math.max(...snapshot.batches.map((b) => b.transfers.length));
    expect(largest).toBeGreaterThan(100);
    expect(snapshot.batches.length).toBeLessThan(Math.ceil(COUNT / 100));

    const sent = sumMutez(
      snapshot.batches.flatMap((batch) => batch.transfers.map((t) => t.amountMutez)),
    );
    expect(sent).toBe(snapshot.distribution.totalToSend);
    expect(sent).toBe(sumMutez(snapshot.lines.map((line) => line.amountMutez)));
    expect(harness.chain.injected.size).toBe(snapshot.batches.length);
  }, 300_000);
});
