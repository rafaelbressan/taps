import { ConfigurationError } from '@tezos-suite/chain';
import type { CycleQueue, QueueRequest, QueueRunResult } from './queue';
import type { PayoutStore } from './store/types';

/**
 * The embedded scheduler — what replaces Redis and Bull.
 *
 * The product this serves is one baker on one machine. A queue server, a
 * broker and a worker pool are three more processes that can be down, and the
 * failure they were bought to survive (a worker dying mid-job) is already
 * survived here by something stronger: the operation hash is durable before
 * injection, so a run that dies anywhere is resumed by re-running it. The
 * scheduler does not need to remember what it was doing. The store does.
 *
 * What it does have to guarantee is narrower, and it is guaranteed here rather
 * than assumed:
 *
 * - **One pass at a time.** A tick arriving while a pass is running is
 *   dropped, counted and recorded — never queued behind it. Two overlapping
 *   passes would both read "cycle 812 is not settled" and both plan it.
 * - **A failure backs off and stays visible.** The interval doubles up to a
 *   ceiling, and every failure is written to the audit trail. The old system
 *   retried `payment_retries` times and then went quiet.
 * - **A halted queue is not a failure to retry.** When RN-28 stops on too many
 *   owed cycles, the scheduler stops asking until a human clears it. Retrying
 *   a decision that is waiting on a person is how a wallet gets emptied in one
 *   go on the day the person comes back.
 * - **Time comes from outside.** `tick()` is called by whoever owns the clock:
 *   `IntervalTicker` in a Node process, a Rust timer in the desktop app. A
 *   scheduler that owns a `setInterval` cannot be tested for any of the above.
 */

export interface SchedulerPolicy {
  /** Between passes, in milliseconds, when everything is healthy. */
  readonly intervalMs: number;
  /** First back-off after a failure. Doubles per consecutive failure. */
  readonly backoffMs: number;
  /** Ceiling for the back-off. */
  readonly maxBackoffMs: number;
}

export type SchedulerStatus =
  /** Nothing running; the next tick will work the queue. */
  | 'idle'
  /** A pass is in flight. */
  | 'running'
  /** The last pass failed; ticks are ignored until the back-off elapses. */
  | 'backing-off'
  /** The queue halted for a human. Ticks do nothing until `resume()`. */
  | 'waiting-for-human'
  /** `stop()` was called. */
  | 'stopped';

export interface SchedulerSnapshot {
  readonly status: SchedulerStatus;
  readonly lastRunStartedAt: Date | null;
  readonly lastRunFinishedAt: Date | null;
  readonly lastResult: QueueRunResult | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  /** Ticks that arrived while a pass was in flight. */
  readonly droppedTicks: number;
  /** When the next tick will be acted on. `null` means "the next one". */
  readonly nextAttemptAt: Date | null;
}

export interface PayoutSchedulerDeps {
  readonly queue: Pick<CycleQueue, 'run'>;
  readonly store: PayoutStore;
  /**
   * What to work on. Read fresh on every pass so that a policy change the
   * baker makes in the app takes effect on the next cycle rather than on the
   * next restart.
   */
  readonly request: () => Promise<QueueRequest> | QueueRequest;
  readonly policy: SchedulerPolicy;
  readonly clock?: () => Date;
}

export function assertSchedulerPolicy(policy: SchedulerPolicy): SchedulerPolicy {
  for (const [name, value] of [
    ['intervalMs', policy.intervalMs],
    ['backoffMs', policy.backoffMs],
    ['maxBackoffMs', policy.maxBackoffMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigurationError(
        `${name} do agendador precisa ser um número inteiro de milissegundos maior que zero`,
      );
    }
  }
  if (policy.maxBackoffMs < policy.backoffMs) {
    throw new ConfigurationError(
      'maxBackoffMs não pode ser menor que backoffMs — o teto ficaria abaixo do piso',
    );
  }
  return policy;
}

export class PayoutScheduler {
  private readonly clock: () => Date;
  private status: SchedulerStatus = 'idle';
  private lastRunStartedAt: Date | null = null;
  private lastRunFinishedAt: Date | null = null;
  private lastResult: QueueRunResult | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private droppedTicks = 0;
  private nextAttemptAt: Date | null = null;

  constructor(private readonly deps: PayoutSchedulerDeps) {
    assertSchedulerPolicy(deps.policy);
    this.clock = deps.clock ?? (() => new Date());
  }

  snapshot(): SchedulerSnapshot {
    return {
      status: this.status,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      droppedTicks: this.droppedTicks,
      nextAttemptAt: this.nextAttemptAt,
    };
  }

  /** Ends the scheduler. Nothing restarts it except a new instance. */
  stop(): void {
    this.status = 'stopped';
    this.nextAttemptAt = null;
  }

  /**
   * Clears a halt a human has dealt with.
   *
   * `actor` and `reason` go into the audit trail verbatim: "the backlog was
   * released" is only useful a year later if it says who released it.
   */
  async resume(actor: string, reason: string): Promise<void> {
    if (this.status !== 'waiting-for-human' && this.status !== 'backing-off') return;
    const request = await this.deps.request();
    await this.deps.store.appendAudit({
      at: this.clock(),
      bakerId: request.bakerId,
      cycle: null,
      actor,
      source: 'scheduler',
      action: 'scheduler.resumed',
      outcome: 'ok',
      params: { previousStatus: this.status, consecutiveFailures: this.consecutiveFailures },
      detail: reason,
    });
    this.status = 'idle';
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.nextAttemptAt = null;
  }

  /**
   * One scheduler tick.
   *
   * Resolves when the pass it started has finished, so a caller that awaits it
   * can never have two in flight. A caller that does not await gets the same
   * guarantee from the `running` guard.
   */
  async tick(): Promise<QueueRunResult | null> {
    const now = this.clock();

    if (this.status === 'stopped' || this.status === 'waiting-for-human') return null;
    if (this.status === 'running') {
      this.droppedTicks += 1;
      return null;
    }
    if (this.nextAttemptAt !== null && now < this.nextAttemptAt) return null;

    this.status = 'running';
    this.lastRunStartedAt = now;
    const request = await this.deps.request();

    try {
      const result = await this.deps.queue.run(request);
      this.lastResult = result;
      this.lastError = null;
      this.lastRunFinishedAt = this.clock();

      if (result.halted) {
        // A halt is the queue asking for a person. The scheduler stops asking.
        this.status = 'waiting-for-human';
        this.nextAttemptAt = null;
        this.consecutiveFailures = 0;
        return result;
      }

      this.consecutiveFailures = 0;
      this.status = 'idle';
      this.nextAttemptAt = new Date(this.lastRunFinishedAt.getTime() + this.deps.policy.intervalMs);
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastRunFinishedAt = this.clock();
      this.status = 'backing-off';
      this.nextAttemptAt = new Date(this.lastRunFinishedAt.getTime() + this.backoff());

      // Written before the throw is swallowed. A scheduler that fails silently
      // is indistinguishable from one that has nothing to do.
      await this.deps.store.appendAudit({
        at: this.lastRunFinishedAt,
        bakerId: request.bakerId,
        cycle: null,
        actor: request.actor,
        source: 'scheduler',
        action: 'scheduler.failed',
        outcome: 'error',
        params: {
          consecutiveFailures: this.consecutiveFailures,
          nextAttemptAt: this.nextAttemptAt.toISOString(),
        },
        detail: this.lastError,
      });
      return null;
    }
  }

  private backoff(): number {
    const { backoffMs, maxBackoffMs } = this.deps.policy;
    const grown = backoffMs * 2 ** (this.consecutiveFailures - 1);
    return grown > maxBackoffMs ? maxBackoffMs : grown;
  }
}

/**
 * The Node clock, for a process that has one.
 *
 * It is deliberately trivial and deliberately separate: everything that
 * decides anything is in `PayoutScheduler`, which has no timer and can
 * therefore be tested for the properties above in milliseconds instead of
 * hours. The desktop app does not use this class — the tick is emitted by the
 * Rust side, because a webview whose window is hidden throttles its timers and
 * a payout that only happens when the window is visible is not a scheduler.
 */
export class IntervalTicker {
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly scheduler: Pick<PayoutScheduler, 'tick'>,
    private readonly everyMs: number,
  ) {
    if (!Number.isInteger(everyMs) || everyMs <= 0) {
      throw new ConfigurationError('o intervalo do relógio precisa ser inteiro e positivo');
    }
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      void this.scheduler.tick();
    }, this.everyMs);
    // Keeps a CLI from hanging on an idle timer when its work is done.
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }
}
