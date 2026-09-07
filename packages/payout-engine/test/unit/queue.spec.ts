import { ConfigurationError } from '@tezos-suite/chain';
import { OwedCyclesExceededError } from '../../src/errors';
import { payoutFactor } from '../../src/minimum';
import { CycleQueue, assertQueueCompleted, loadQueueLimits } from '../../src/queue';
import { InMemoryPayoutStore } from '../../src/store/memory';
import { tz1 } from '../helpers/addresses';
import { buildHarness } from '../helpers/engine';
import { FakeChain } from '../helpers/fake-chain';
import { delegator, makeSplit } from '../helpers/split';

const BAKER = tz1(1);
const ALICE = tz1(301);
const BOB = tz1(302);

const FIRST = 800;

function splitFor(cycle: number) {
  return makeSplit({
    baker: BAKER,
    cycle,
    ownDelegatedBalance: 0n,
    delegatedRewards: 10_000_000n,
    delegators: [delegator(ALICE, 600_000_000n), delegator(BOB, 400_000_000n)],
  });
}

/**
 * The queue over a harness that shares one chain and one store across every
 * cycle, which is what a real installation has.
 *
 * `headCycle` is what decides how far the backlog reaches: with
 * `denunciation_period + slashing_delay == 2` in the test constants, a head
 * of 804 makes 800, 801 and 802 distributable and 803 not yet.
 */
function buildQueue(options: {
  headCycle: number;
  maxOwedCycles: number;
  store?: InMemoryPayoutStore;
  chain?: FakeChain;
  onPlan?: (cycle: number, chain: FakeChain) => void;
}) {
  const store = options.store ?? new InMemoryPayoutStore();
  const chain = options.chain ?? new FakeChain();
  const harness = buildHarness({
    split: splitFor(FIRST),
    splitFor: (cycle) => {
      options.onPlan?.(cycle, chain);
      return splitFor(cycle);
    },
    store,
    chain,
    headCycle: options.headCycle,
    feeMutez: 500n,
  });

  const queue = new CycleQueue({
    engine: harness.engine,
    store,
    constants: async () => harness.constants,
    headCycle: async () => options.headCycle,
    loadSplit: async (_baker, cycle) => splitFor(cycle),
  });

  return {
    queue,
    store,
    chain,
    harness,
    request: {
      bakerId: BAKER,
      fromCycle: FIRST,
      actor: 'test-operator',
      source: 'unit-test',
      policy: harness.request.policy,
      limits: { maxOwedCycles: options.maxOwedCycles },
    },
  };
}

describe('the queue of owed cycles (RN-28)', () => {
  it('processes every owed cycle in ascending order, one at a time', async () => {
    const seen: number[] = [];
    const context = buildQueue({
      headCycle: 804,
      maxOwedCycles: 3,
      onPlan: (cycle) => seen.push(cycle),
    });

    const result = await context.queue.run(context.request);

    expect(result.owed).toEqual([800, 801, 802]);
    expect(result.halted).toBe(false);
    expect(result.pending).toEqual([]);
    expect(result.processed.map((run) => run.cycle)).toEqual([800, 801, 802]);
    expect(result.processed.every((run) => run.status === 'settled')).toBe(true);
    expect(seen).toEqual([800, 801, 802]);

    // One distribution, one batch, one hash per cycle — never one batch for
    // the backlog.
    expect(context.chain.injected.size).toBe(3);
    const hashes = result.processed.flatMap((run) => run.injected);
    expect(new Set(hashes).size).toBe(3);
  });

  it('leaves a settled cycle alone and pays only what is still owed', async () => {
    const first = buildQueue({ headCycle: 804, maxOwedCycles: 3 });
    await first.queue.run({ ...first.request, fromCycle: 800 });

    // Same store, same chain, run again: everything is settled now.
    const again = await first.queue.run(first.request);
    expect(again.owed).toEqual([]);
    expect(again.processed).toEqual([]);
    expect(first.chain.injected.size).toBe(3);
  });

  it('stops at the cycle that failed and never reaches the next one', async () => {
    const attempted: number[] = [];
    const context = buildQueue({
      headCycle: 804,
      maxOwedCycles: 3,
      onPlan: (cycle, chain) => {
        attempted.push(cycle);
        // Cycle 801 lands in a block with a status other than applied.
        chain.nextInjectionStatus = cycle === 801 ? 'backtracked' : 'applied';
      },
    });

    const result = await context.queue.run(context.request);

    expect(result.halted).toBe(true);
    expect(result.haltedAt).toBe(801);
    expect(result.reason).toMatch(/cycle 801 ended "failed"/);
    expect(result.processed.map((run) => run.cycle)).toEqual([800, 801]);

    // The one that matters: 802 was never planned, never estimated, never
    // signed. Stepping over a broken cycle is how one silently goes unpaid.
    expect(attempted).toEqual([800, 801]);
    expect(result.pending).toEqual([802]);
    expect(await context.store.getDistribution(BAKER, 802)).toBeUndefined();

    expect(() => assertQueueCompleted(result)).toThrow(/cycle 801/);
  });

  it('does not step over a cycle the engine refuses to replan', async () => {
    const context = buildQueue({
      headCycle: 804,
      maxOwedCycles: 3,
      onPlan: (cycle, chain) => {
        chain.nextInjectionStatus = cycle === 800 ? 'backtracked' : 'applied';
      },
    });

    await context.queue.run(context.request);
    // Second pass: 800 is on record as `failed`, and re-sending the same
    // bytes would burn the fees again. The queue stops there rather than
    // moving on to 801.
    const second = await context.queue.run(context.request);

    expect(second.owed).toEqual([800, 801, 802]);
    expect(second.halted).toBe(true);
    expect(second.haltedAt).toBe(800);
    expect(second.reason).toMatch(/ended failed on chain/);
    expect(await context.store.getDistribution(BAKER, 801)).toBeUndefined();
  });
});

describe('the limit on owed cycles (RN-28)', () => {
  it('injects nothing at all above the limit, and prices what is owed', async () => {
    // Head 805 makes 800..803 distributable: four owed against a limit of 3.
    const context = buildQueue({ headCycle: 805, maxOwedCycles: 3 });

    const result = await context.queue.run(context.request);

    expect(result.owed).toEqual([800, 801, 802, 803]);
    expect(result.halted).toBe(true);
    expect(result.haltedAt).toBeNull();
    expect(result.pending).toEqual([800, 801, 802, 803]);
    expect(result.processed).toEqual([]);

    // Not the oldest one, not the first one, none of them.
    expect(context.chain.injected.size).toBe(0);
    expect(context.harness.signer.signed).toHaveLength(0);
    for (const cycle of result.owed) {
      expect(await context.store.getDistribution(BAKER, cycle)).toBeUndefined();
    }

    // The human is told how much is waiting, per cycle and in total.
    expect(result.outstanding.map((entry) => entry.cycle)).toEqual([800, 801, 802, 803]);
    expect(result.outstandingMutez).toBe(4n * 9_500_000n);
    expect(() => assertQueueCompleted(result)).toThrow(OwedCyclesExceededError);
  });

  it('records every owed cycle before it stops', async () => {
    const context = buildQueue({ headCycle: 805, maxOwedCycles: 3 });
    await context.queue.run(context.request);

    const audit = await context.store.listAudit(BAKER);
    const owed = audit.filter((event) => event.action === 'queue.owed');
    expect(owed.map((event) => event.cycle)).toEqual([800, 801, 802, 803]);
    expect(audit.some((event) => event.action === 'queue.halted')).toBe(true);
  });

  it('reports a cycle it could not price as unknown, never as zero', async () => {
    const context = buildQueue({ headCycle: 805, maxOwedCycles: 3 });
    const queue = new CycleQueue({
      engine: context.harness.engine,
      store: context.store,
      constants: async () => context.harness.constants,
      headCycle: async () => 805,
      loadSplit: async (_baker, cycle) => {
        if (cycle === 802) throw new Error('tzkt returned 502');
        return splitFor(cycle);
      },
    });

    const result = await queue.run(context.request);
    const broken = result.outstanding.find((entry) => entry.cycle === 802)!;

    expect(broken.distributableMutez).toBeNull();
    expect(broken.error).toMatch(/502/);
    // A total that silently dropped one cycle would understate the backlog,
    // which is the one number the decision turns on.
    expect(result.outstandingMutez).toBeNull();
  });

  it('runs the backlog once the limit allows it', async () => {
    const context = buildQueue({ headCycle: 805, maxOwedCycles: 4 });
    const result = await context.queue.run(context.request);

    expect(result.halted).toBe(false);
    expect(result.processed.map((run) => run.cycle)).toEqual([800, 801, 802, 803]);
    expect(context.chain.injected.size).toBe(4);
  });
});

describe('the limit itself', () => {
  it('has no default: an unset limit stops the process', () => {
    expect(() => loadQueueLimits({})).toThrow(ConfigurationError);
    expect(() => loadQueueLimits({ TAPS_PAYOUT_MAX_OWED_CYCLES: '0' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadQueueLimits({ TAPS_PAYOUT_MAX_OWED_CYCLES: 'três' })).toThrow(
      ConfigurationError,
    );
    expect(loadQueueLimits({ TAPS_PAYOUT_MAX_OWED_CYCLES: '3' })).toEqual({
      maxOwedCycles: 3,
    });
  });

  it('refuses a first cycle that is not a cycle', async () => {
    const context = buildQueue({ headCycle: 804, maxOwedCycles: 3 });
    await expect(
      context.queue.run({ ...context.request, fromCycle: -1 }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('carries K through to every cycle it runs', async () => {
    const context = buildQueue({ headCycle: 804, maxOwedCycles: 3 });
    await context.queue.run({
      ...context.request,
      policy: { ...context.request.policy, payoutFactor: payoutFactor(3n, 1n) },
    });

    for (const cycle of [800, 801, 802]) {
      const snapshot = (await context.store.getDistribution(BAKER, cycle))!;
      expect(snapshot.distribution.payoutFactorNumerator).toBe(3n);
    }
  });
});
