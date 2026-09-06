import {
  ConfigurationError,
  computePayout,
  sumMutez,
  type Mutez,
  type ProtocolConstants,
  type RewardSplit,
} from '@tezos-suite/chain';
import type { EnginePolicy, PayoutEngine, PayoutRunResult } from './engine';
import { OwedCyclesExceededError } from './errors';
import { isCycleDistributable } from './schedule';
import type { PayoutStore } from './store/types';

/**
 * The queue of owed cycles (RN-28).
 *
 * The failure it removes is in the current TAPS and is silent: the system
 * compares the network's pending cycle with the local one and processes
 * ONLY the local one, then writes the network's as the new local. Off for
 * three cycles means 801, 802 and 803 are never paid and nothing anywhere
 * says they were skipped.
 *
 * Three properties, and each of them is a separate way of losing money:
 *
 * - **Ascending order, one at a time.** Every cycle is its own distribution,
 *   its own batch, its own hash.
 * - **A failure stops the queue at that cycle.** It does not step over it.
 *   Skipping "so the queue keeps moving" is how a cycle gets paid twice, or
 *   never, with nobody noticing.
 * - **Above a configured number of owed cycles, nothing is paid.** The
 *   cycles are recorded, the accumulated total is reported, and a human
 *   decides. This exists for one concrete scenario: coming back from a trip
 *   to a wallet emptied in one go because the system decided on its own to
 *   pay a week of cycles.
 */

export interface QueueLimits {
  /** How many cycles may be owed before the queue stops and asks. */
  readonly maxOwedCycles: number;
}

const MAX_OWED_ENV = 'TAPS_PAYOUT_MAX_OWED_CYCLES';

/**
 * Reads the limit from the environment. Missing or unparseable stops the
 * process, for the same reason the cycle ceiling does: a limit nobody chose
 * is not a limit, and the operator would never know it was absent.
 */
export function loadQueueLimits(env: NodeJS.ProcessEnv = process.env): QueueLimits {
  const raw = env[MAX_OWED_ENV];
  if (!raw || raw.trim() === '') {
    throw new ConfigurationError(
      `${MAX_OWED_ENV} is not set — without it the queue would pay any number of ` +
        'backlogged cycles unattended; set it to the number of cycles that may run ' +
        'without a human looking',
    );
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigurationError(
      `${MAX_OWED_ENV} must be a whole number of cycles, got ${JSON.stringify(raw)}`,
    );
  }
  const maxOwedCycles = Number(raw.trim());
  if (maxOwedCycles <= 0) {
    throw new ConfigurationError(`${MAX_OWED_ENV} must be greater than zero`);
  }
  return { maxOwedCycles };
}

export interface CycleQueueDeps {
  readonly engine: Pick<PayoutEngine, 'run'>;
  readonly store: PayoutStore;
  readonly constants: () => Promise<ProtocolConstants>;
  readonly headCycle: () => Promise<number>;
  /**
   * Only used to price the backlog when the queue halts. Nothing is signed
   * from it — the engine re-reads the split for itself before it pays.
   */
  readonly loadSplit: (bakerId: string, cycle: number) => Promise<RewardSplit>;
  readonly clock?: () => Date;
}

export interface QueueRequest {
  readonly bakerId: string;
  /**
   * The first cycle this installation is responsible for.
   *
   * There is no default. Without it "every distributable cycle not settled"
   * reaches back to the chain's genesis, and the difference between "3 owed"
   * and "3000 owed" is exactly the alarm this queue exists to raise.
   */
  readonly fromCycle: number;
  readonly actor: string;
  readonly source: string;
  readonly policy: EnginePolicy;
  readonly limits: QueueLimits;
}

/** One owed cycle, priced, for the message a human reads before deciding. */
export interface OwedCycleReport {
  readonly cycle: number;
  /**
   * What the delegators of that cycle are owed before the cut, in mutez.
   * `null` when the split could not be read — never zero, because a zero
   * that means "we could not tell" is the bug this whole engine is a
   * reaction to.
   */
  readonly distributableMutez: Mutez | null;
  readonly error: string | null;
}

export interface QueueRunResult {
  readonly bakerId: string;
  /** Every cycle owed at the start of this pass, ascending. */
  readonly owed: readonly number[];
  readonly halted: boolean;
  /** The cycle the queue stopped at, if it stopped on one. */
  readonly haltedAt: number | null;
  readonly reason: string | null;
  /** Present when the halt came from an engine error, verbatim. */
  readonly cause: unknown;
  readonly processed: readonly PayoutRunResult[];
  /** Owed cycles this pass never attempted. */
  readonly pending: readonly number[];
  /** Priced backlog. Only filled when the queue halted on the limit. */
  readonly outstanding: readonly OwedCycleReport[];
  /** Σ of `outstanding`, or `null` when any cycle could not be priced. */
  readonly outstandingMutez: Mutez | null;
}

export class CycleQueue {
  private readonly clock: () => Date;

  constructor(private readonly deps: CycleQueueDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Works the queue and returns what happened, halt included.
   *
   * A halt is returned rather than thrown because RN-28 asks for something an
   * exception is bad at carrying: the backlog, priced, so the human can
   * decide. Nothing is silent about it either — every halt writes an audit
   * event, and `assertQueueCompleted` turns the result back into a throw for
   * callers that want one.
   */
  async run(request: QueueRequest): Promise<QueueRunResult> {
    const constants = await this.deps.constants();
    const headCycle = await this.deps.headCycle();
    const owed = await this.owedCycles(request, headCycle, constants);

    await this.audit(request, null, 'queue.scanned', 'ok', {
      fromCycle: request.fromCycle,
      headCycle,
      owed,
      maxOwedCycles: request.limits.maxOwedCycles,
    });

    if (owed.length === 0) {
      return this.result(request.bakerId, owed, { processed: [], pending: [] });
    }

    if (owed.length > request.limits.maxOwedCycles) {
      // Recorded as owed, priced, and left alone. Nothing is injected on this
      // path — not the first cycle, not the oldest one, none of them.
      const outstanding = await this.priceBacklog(request, owed);
      for (const entry of outstanding) {
        await this.audit(request, entry.cycle, 'queue.owed', 'ok', {
          distributableMutez: entry.distributableMutez?.toString() ?? null,
          error: entry.error,
        });
      }
      const outstandingMutez = outstanding.every((e) => e.distributableMutez !== null)
        ? sumMutez(outstanding.map((e) => e.distributableMutez as Mutez))
        : null;
      const blocked = new OwedCyclesExceededError(
        request.bakerId,
        owed,
        request.limits.maxOwedCycles,
      );
      await this.audit(request, null, 'queue.halted', 'refused', {
        reason: blocked.message,
        owed,
        outstandingMutez: outstandingMutez?.toString() ?? null,
      });
      return this.result(request.bakerId, owed, {
        processed: [],
        pending: owed,
        halted: true,
        reason: blocked.message,
        cause: blocked,
        outstanding,
        outstandingMutez,
      });
    }

    const processed: PayoutRunResult[] = [];
    for (const [position, cycle] of owed.entries()) {
      let result: PayoutRunResult;
      try {
        result = await this.deps.engine.run({
          bakerId: request.bakerId,
          cycle,
          actor: request.actor,
          source: request.source,
          policy: request.policy,
        });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        await this.audit(request, cycle, 'queue.halted', 'error', { reason });
        return this.result(request.bakerId, owed, {
          processed,
          pending: owed.slice(position),
          halted: true,
          haltedAt: cycle,
          reason,
          cause,
        });
      }

      processed.push(result);
      if (result.status !== 'settled') {
        // The cycle did not close. The next one is NOT started: whatever went
        // wrong here is still true one cycle later, and stepping over it is
        // how a cycle silently goes unpaid.
        const reason =
          `cycle ${cycle} ended "${result.status}" instead of settled; the queue stops here`;
        await this.audit(request, cycle, 'queue.halted', 'error', { reason });
        return this.result(request.bakerId, owed, {
          processed,
          pending: owed.slice(position + 1),
          halted: true,
          haltedAt: cycle,
          reason,
        });
      }
    }

    return this.result(request.bakerId, owed, { processed, pending: [] });
  }

  /**
   * Every distributable cycle from `fromCycle` on that has not settled.
   *
   * A cycle left `failed` or `blocked` is still owed, and it comes back at
   * the head of the queue — where the engine's own refusal to replan it
   * stops the pass, which is the behaviour RN-28 asks for.
   */
  private async owedCycles(
    request: QueueRequest,
    headCycle: number,
    constants: ProtocolConstants,
  ): Promise<number[]> {
    if (!Number.isInteger(request.fromCycle) || request.fromCycle < 0) {
      throw new ConfigurationError(
        `fromCycle must be a non-negative whole cycle, got ${request.fromCycle}`,
      );
    }
    const statuses = await this.deps.store.listCycleStatuses(request.bakerId);
    const owed: number[] = [];
    for (
      let cycle = request.fromCycle;
      isCycleDistributable(cycle, headCycle, constants);
      cycle += 1
    ) {
      if (statuses.get(cycle) === 'settled') continue;
      owed.push(cycle);
    }
    return owed;
  }

  /**
   * What the backlog is worth, so the human deciding has the number in front
   * of them. Reads only; a cycle that cannot be read is reported as unknown
   * and never as zero.
   */
  private async priceBacklog(
    request: QueueRequest,
    owed: readonly number[],
  ): Promise<OwedCycleReport[]> {
    const reports: OwedCycleReport[] = [];
    for (const cycle of owed) {
      try {
        const split = await this.deps.loadSplit(request.bakerId, cycle);
        const plan = computePayout({
          split,
          fee: request.policy.fee,
          includeBlockFees: request.policy.includeBlockFees,
        });
        reports.push({ cycle, distributableMutez: plan.distributable, error: null });
      } catch (cause) {
        reports.push({
          cycle,
          distributableMutez: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return reports;
  }

  private result(
    bakerId: string,
    owed: readonly number[],
    parts: {
      processed: readonly PayoutRunResult[];
      pending: readonly number[];
      halted?: boolean;
      haltedAt?: number;
      reason?: string;
      cause?: unknown;
      outstanding?: readonly OwedCycleReport[];
      outstandingMutez?: Mutez | null;
    },
  ): QueueRunResult {
    return {
      bakerId,
      owed,
      halted: parts.halted ?? false,
      haltedAt: parts.haltedAt ?? null,
      reason: parts.reason ?? null,
      cause: parts.cause,
      processed: parts.processed,
      pending: parts.pending,
      outstanding: parts.outstanding ?? [],
      outstandingMutez: parts.outstandingMutez ?? null,
    };
  }

  private async audit(
    request: QueueRequest,
    cycle: number | null,
    action: string,
    outcome: 'ok' | 'refused' | 'error',
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.appendAudit({
      at: this.clock(),
      bakerId: request.bakerId,
      cycle,
      actor: request.actor,
      source: request.source,
      action,
      outcome,
      params,
    });
  }
}

/** Turns a halted pass back into a throw, for a caller that wants one. */
export function assertQueueCompleted(result: QueueRunResult): void {
  if (!result.halted) return;
  if (result.cause instanceof Error) throw result.cause;
  throw new Error(
    `${result.bakerId}: the cycle queue halted at ${result.haltedAt ?? 'the limit check'} — ` +
      `${result.reason ?? 'no reason recorded'}`,
  );
}
