import {
  NoOpenDebtError,
  OpenSettlementError,
  PayoutBlockedError,
  SettlementWindowError,
} from '../../src/errors';
import { payoutFactor } from '../../src/minimum';
import { buildOpenDebtReport } from '../../src/report';
import { InMemoryPayoutStore } from '../../src/store/memory';
import { tz1 } from '../helpers/addresses';
import { buildHarness, BAKER } from '../helpers/engine';
import { FakeChain } from '../helpers/fake-chain';
import { delegator, makeSplit } from '../helpers/split';

const CYCLE = 900;
const WHALE = tz1(401);
/** Owed 190 mutez a cycle, against a transfer that costs 500. */
const TINY = tz1(402);

const TRANSFER_COST = 500n;
const LIMITS = { cycleCapMutez: 10_000_000_000n };

function splitWithDust(cycle = CYCLE) {
  return makeSplit({
    baker: BAKER,
    cycle,
    ownDelegatedBalance: 0n,
    delegatedRewards: 10_000_000n,
    delegators: [delegator(WHALE, 999_000_000_000n), delegator(TINY, 20_000_000n)],
  });
}

/** Runs one cycle so that TINY ends it with a debt the cut held back. */
async function withOpenDebt(store: InMemoryPayoutStore, chain: FakeChain, cycle = CYCLE) {
  const harness = buildHarness({
    split: splitWithDust(cycle),
    feeMutez: TRANSFER_COST,
    payoutFactor: payoutFactor(1n, 1n),
    store,
    chain,
    headCycle: CYCLE + 20,
  });
  const result = await harness.engine.run({ ...harness.request, cycle });
  expect(result.lines.find((line) => line.address === TINY)!.paid).toBe(false);
  return harness;
}

function settlementRequest(overrides: Record<string, unknown> = {}) {
  return {
    bakerId: BAKER,
    settlementId: 'ticket-4711',
    addresses: [TINY],
    actor: 'rafael',
    source: 'cli',
    reason: 'TINY stopped delegating and asked for the balance',
    limits: LIMITS,
    ...overrides,
  };
}

describe('settling an open debt on request (RN-24, borda 1)', () => {
  it('pays a balance the cut would never let through, and clears it', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    expect((await store.loadCarryOver(BAKER)).get(TINY)).toBe(190n);

    const result = await harness.engine.settleDebt(settlementRequest());

    expect(result.status).toBe('settled');
    expect(result.injected).toHaveLength(1);
    expect(result.paid).toEqual([{ address: TINY, amountMutez: 190n }]);
    expect(result.totalPaid).toBe(190n);

    // The whole point: 190 mutez moved at a cost of 500. The automatic path
    // would never do this, and a debt that can never clear is not a debt the
    // baker gets to keep.
    const settlement = (await store.getDebtSettlement(BAKER, 'ticket-4711'))!;
    expect(settlement.totalFees).toBe(TRANSFER_COST);
    expect(settlement.totalFees).toBeGreaterThan(settlement.totalAmount);

    expect((await store.loadCarryOver(BAKER)).get(TINY)).toBeUndefined();
    expect(buildOpenDebtReport(BAKER, await store.loadCarryOver(BAKER)).rows).toEqual([]);
  });

  it('pays once when asked twice under the same id', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    const first = await harness.engine.settleDebt(settlementRequest());
    const injectedAfterFirst = chain.injected.size;

    const second = await harness.engine.settleDebt(settlementRequest());

    expect(second.injected).toEqual([]);
    expect(second.skipped).toEqual(first.injected);
    expect(second.status).toBe('settled');
    expect(chain.injected.size).toBe(injectedAfterFirst);
  });

  it('resumes a lost confirmation without paying again', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    // The node accepted the operation and the answer was lost.
    chain.landThenFailNextInjection = true;
    await expect(harness.engine.settleDebt(settlementRequest())).rejects.toThrow(
      /connection reset/,
    );

    const midway = (await store.getDebtSettlement(BAKER, 'ticket-4711'))!;
    expect(midway.opHash).not.toBeNull();
    expect(chain.injected.has(midway.opHash!)).toBe(true);
    // The debt is still on record: nothing is cleared before the chain says so.
    expect((await store.loadCarryOver(BAKER)).get(TINY)).toBe(190n);

    const resumed = await harness.engine.settleDebt(settlementRequest());
    expect(resumed.status).toBe('settled');
    expect(resumed.injected).toEqual([]);
    expect(chain.injected.size).toBe(2); // the cycle's batch and this one
    expect((await store.loadCarryOver(BAKER)).get(TINY)).toBeUndefined();
  });

  it('does not clear the debt when the operation is rejected', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    chain.nextInjectionStatus = 'backtracked';
    const result = await harness.engine.settleDebt(settlementRequest());

    expect(result.status).toBe('failed');
    expect(result.totalPaid).toBe(0n);
    expect((await store.loadCarryOver(BAKER)).get(TINY)).toBe(190n);

    // Not retried under the same name: the same bytes meet the same fate, and
    // asking again is another decision.
    chain.nextInjectionStatus = 'applied';
    await expect(harness.engine.settleDebt(settlementRequest())).rejects.toThrow(
      PayoutBlockedError,
    );
  });

  it('refuses an address that owes nothing', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    await expect(
      harness.engine.settleDebt(settlementRequest({ addresses: [WHALE] })),
    ).rejects.toThrow(NoOpenDebtError);
    expect(chain.injected.size).toBe(1);
  });

  it('refuses while a cycle distribution is still open', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    // A second cycle whose injection never got an answer: the hash is on
    // record and the distribution is `sending`.
    const next = buildHarness({
      split: splitWithDust(CYCLE + 1),
      feeMutez: TRANSFER_COST,
      payoutFactor: payoutFactor(1n, 1n),
      store,
      chain,
      headCycle: CYCLE + 20,
    });
    chain.failNextInjection = new Error('rpc unreachable');
    await expect(
      next.engine.run({ ...next.request, cycle: CYCLE + 1 }),
    ).rejects.toThrow(/rpc unreachable/);

    // That run already read the balance it means to pay. Settling it here as
    // well would pay it twice.
    await expect(harness.engine.settleDebt(settlementRequest())).rejects.toThrow(
      SettlementWindowError,
    );
  });

  it('covers the allocation burn when the destination has to be created', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    // An implicit account at zero is not allocated: paying it burns storage,
    // and a `storage_limit` of zero would take the operation down.
    chain.balanceOf.set(TINY, 0n);

    const result = await harness.engine.settleDebt(settlementRequest());
    const settlement = (await store.getDebtSettlement(BAKER, 'ticket-4711'))!;

    expect(result.status).toBe('settled');
    expect(settlement.lines[0]!.storageLimit).toBe(257n);
    expect(settlement.totalBurn).toBe(64_250n);
  });

  it('writes who asked and why, against no cycle at all', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);
    await harness.engine.settleDebt(settlementRequest());

    const audit = await store.listAudit(BAKER);
    const settled = audit.find((event) => event.action === 'settlement.settled')!;
    expect(settled.actor).toBe('rafael');
    // It belongs to no cycle, so it never lands in a cycle's reconciliation.
    expect(settled.cycle).toBeNull();

    const requested = audit.find((event) => event.action === 'settlement.requested')!;
    expect(requested.params.reason).toMatch(/stopped delegating/);
  });

  it('refuses to plan a cycle while a settlement is in flight', async () => {
    const store = new InMemoryPayoutStore();
    const chain = new FakeChain();
    const harness = await withOpenDebt(store, chain);

    // The settlement was injected and never confirmed: the debt is still on
    // record and the operation may still land.
    chain.landThenFailNextInjection = true;
    await expect(harness.engine.settleDebt(settlementRequest())).rejects.toThrow(
      /connection reset/,
    );
    expect((await store.loadCarryOver(BAKER)).get(TINY)).toBe(190n);

    // The mirror of the check above: planning the next cycle would read that
    // same 190 and pay it a second time.
    const next = buildHarness({
      split: splitWithDust(CYCLE + 1),
      feeMutez: TRANSFER_COST,
      payoutFactor: payoutFactor(1n, 1n),
      store,
      chain,
      headCycle: CYCLE + 20,
    });
    await expect(
      next.engine.run({ ...next.request, cycle: CYCLE + 1 }),
    ).rejects.toThrow(OpenSettlementError);
    expect(await store.getDistribution(BAKER, CYCLE + 1)).toBeUndefined();

    // Once the settlement resolves, the cycle plans and pays normally.
    await harness.engine.settleDebt(settlementRequest());
    const result = await next.engine.run({ ...next.request, cycle: CYCLE + 1 });
    expect(result.status).toBe('settled');
    expect(result.lines.find((line) => line.address === TINY)!.carriedIn).toBe(0n);
  });
});
