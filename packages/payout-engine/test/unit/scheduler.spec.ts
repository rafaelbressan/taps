import { ConfigurationError, feeRate } from '@tezos-suite/chain';
import { payoutFactor } from '../../src/minimum';
import type { QueueRequest, QueueRunResult } from '../../src/queue';
import { PayoutScheduler } from '../../src/scheduler';
import { InMemoryPayoutStore } from '../../src/store/memory';
import { tz1 } from '../helpers/addresses';

/**
 * The scheduler replaces Redis and Bull, so what has to be proven is exactly
 * what the broker was bought for: no two passes at once, a failure that backs
 * off instead of hammering, and a halt that waits for a person.
 */
describe('the embedded scheduler', () => {
  const BAKER = tz1(1);

  const request: QueueRequest = {
    bakerId: BAKER,
    fromCycle: 1300,
    actor: 'agendador',
    source: 'scheduler',
    policy: {
      fee: feeRate(10n, 100n),
      includeBlockFees: true,
      payoutFactor: payoutFactor(1n, 1n),
      limits: { cycleCapMutez: 1_000_000_000n },
    },
    limits: { maxOwedCycles: 3 },
  };

  const policy = { intervalMs: 60_000, backoffMs: 1_000, maxBackoffMs: 8_000 };

  function result(overrides: Partial<QueueRunResult> = {}): QueueRunResult {
    return {
      bakerId: BAKER,
      owed: [],
      halted: false,
      haltedAt: null,
      reason: null,
      cause: null,
      processed: [],
      pending: [],
      outstanding: [],
      outstandingMutez: null,
      ...overrides,
    };
  }

  function build(
    run: (request: QueueRequest) => Promise<QueueRunResult>,
    clock: () => Date,
  ) {
    const store = new InMemoryPayoutStore();
    const scheduler = new PayoutScheduler({
      queue: { run },
      store,
      request: () => request,
      policy,
      clock,
    });
    return { scheduler, store };
  }

  let now = new Date('2026-09-06T12:00:00Z');
  const clock = () => now;
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  beforeEach(() => {
    now = new Date('2026-09-06T12:00:00Z');
  });

  it('refuses a policy without a real interval', () => {
    expect(
      () =>
        new PayoutScheduler({
          queue: { run: async () => result() },
          store: new InMemoryPayoutStore(),
          request: () => request,
          policy: { intervalMs: 0, backoffMs: 1_000, maxBackoffMs: 8_000 },
        }),
    ).toThrow(ConfigurationError);
  });

  it('runs the queue and goes back to idle with the next attempt scheduled', async () => {
    const { scheduler } = build(async () => result({ owed: [1301] }), clock);

    const first = await scheduler.tick();
    expect(first!.owed).toEqual([1301]);

    const snapshot = scheduler.snapshot();
    expect(snapshot.status).toBe('idle');
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.nextAttemptAt!.toISOString()).toBe('2026-09-06T12:01:00.000Z');
  });

  it('ignores a tick before the interval has elapsed', async () => {
    let runs = 0;
    const { scheduler } = build(async () => {
      runs += 1;
      return result();
    }, clock);

    await scheduler.tick();
    advance(30_000);
    expect(await scheduler.tick()).toBeNull();
    expect(runs).toBe(1);

    advance(30_000);
    await scheduler.tick();
    expect(runs).toBe(2);
  });

  it('drops a tick that arrives while a pass is in flight', async () => {
    let release: () => void = () => {};
    let runs = 0;
    const { scheduler } = build(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result();
    }, clock);

    const inFlight = scheduler.tick();
    await Promise.resolve();
    expect(scheduler.snapshot().status).toBe('running');

    expect(await scheduler.tick()).toBeNull();
    expect(await scheduler.tick()).toBeNull();
    expect(scheduler.snapshot().droppedTicks).toBe(2);

    release();
    await inFlight;
    expect(runs).toBe(1);
  });

  it('backs off, doubling, and records every failure', async () => {
    const { scheduler, store } = build(async () => {
      throw new Error('o signer não respondeu');
    }, clock);

    await scheduler.tick();
    expect(scheduler.snapshot().status).toBe('backing-off');
    expect(scheduler.snapshot().nextAttemptAt!.toISOString()).toBe('2026-09-06T12:00:01.000Z');

    advance(1_000);
    await scheduler.tick();
    expect(scheduler.snapshot().consecutiveFailures).toBe(2);
    expect(scheduler.snapshot().nextAttemptAt!.toISOString()).toBe('2026-09-06T12:00:03.000Z');

    advance(2_000);
    await scheduler.tick();
    expect(scheduler.snapshot().nextAttemptAt!.toISOString()).toBe('2026-09-06T12:00:07.000Z');

    const audit = await store.listAudit(BAKER);
    expect(audit).toHaveLength(3);
    expect(audit.every((event) => event.action === 'scheduler.failed')).toBe(true);
    expect(audit[0]!.detail).toBe('o signer não respondeu');
    expect(audit[0]!.outcome).toBe('error');
  });

  it('never backs off past the ceiling', async () => {
    const { scheduler } = build(async () => {
      throw new Error('caiu de novo');
    }, clock);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      advance(60_000);
      await scheduler.tick();
    }
    const wait = scheduler.snapshot().nextAttemptAt!.getTime() - now.getTime();
    expect(wait).toBe(8_000);
  });

  it('clears the failure count after a pass that works', async () => {
    let fail = true;
    const { scheduler } = build(async () => {
      if (fail) throw new Error('temporário');
      return result();
    }, clock);

    await scheduler.tick();
    expect(scheduler.snapshot().consecutiveFailures).toBe(1);

    fail = false;
    advance(1_000);
    await scheduler.tick();
    expect(scheduler.snapshot().consecutiveFailures).toBe(0);
    expect(scheduler.snapshot().status).toBe('idle');
    expect(scheduler.snapshot().lastError).toBeNull();
  });

  it('stops asking once the queue halts for a human', async () => {
    let runs = 0;
    const { scheduler } = build(async () => {
      runs += 1;
      return result({
        halted: true,
        haltedAt: 1301,
        owed: [1301, 1302, 1303, 1304],
        reason: 'ciclos devidos acima do limite',
        pending: [1301, 1302, 1303, 1304],
      });
    }, clock);

    await scheduler.tick();
    expect(scheduler.snapshot().status).toBe('waiting-for-human');

    // No amount of time makes it try again. That is the point: the backlog is
    // waiting on a decision, not on a retry.
    advance(24 * 60 * 60 * 1000);
    expect(await scheduler.tick()).toBeNull();
    expect(runs).toBe(1);
  });

  it('runs again once a human resumes it, and says who did', async () => {
    let runs = 0;
    const { scheduler, store } = build(async () => {
      runs += 1;
      return runs === 1
        ? result({ halted: true, haltedAt: 1301, reason: 'acima do limite' })
        : result();
    }, clock);

    await scheduler.tick();
    await scheduler.resume('rafael', 'conferi os quatro ciclos e liberei');

    const audit = await store.listAudit(BAKER);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('scheduler.resumed');
    expect(audit[0]!.actor).toBe('rafael');
    expect(audit[0]!.detail).toBe('conferi os quatro ciclos e liberei');

    await scheduler.tick();
    expect(runs).toBe(2);
    expect(scheduler.snapshot().status).toBe('idle');
  });

  it('does nothing at all once stopped', async () => {
    let runs = 0;
    const { scheduler } = build(async () => {
      runs += 1;
      return result();
    }, clock);

    scheduler.stop();
    expect(await scheduler.tick()).toBeNull();
    expect(runs).toBe(0);
    expect(scheduler.snapshot().status).toBe('stopped');
  });

  it('reads the request fresh on every pass', async () => {
    const seen: number[] = [];
    let fromCycle = 1300;
    const scheduler = new PayoutScheduler({
      queue: {
        run: async (received) => {
          seen.push(received.fromCycle);
          return result();
        },
      },
      store: new InMemoryPayoutStore(),
      request: () => ({ ...request, fromCycle }),
      policy,
      clock,
    });

    await scheduler.tick();
    fromCycle = 1310;
    advance(60_000);
    await scheduler.tick();

    expect(seen).toEqual([1300, 1310]);
  });
});
