import { ChainLayerError } from '@tezos-suite/chain';

/**
 * Nothing in this package degrades into a default. Every error below names
 * the thing that did not hold, because the failure mode this engine exists
 * to remove is the one that reports success: a distribution that pays zero,
 * or pays twice, and raises nothing.
 */
export class PayoutEngineError extends ChainLayerError {}

/**
 * The store already holds a distribution for this `(baker, cycle)`.
 *
 * This is the error the database must be able to raise on its own. The
 * current TAPS key is `@@unique([bakerId, cycle, date, result])`, which lets
 * the same cycle be written again on another day, or with another result —
 * so "already paid" is representable twice and duplicate payment is a legal
 * database state.
 */
export class DuplicateDistributionError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly cycle: number,
  ) {
    super(
      `${bakerId} already has a distribution for cycle ${cycle} — ` +
        'a second one would pay the same delegators again',
    );
  }
}

/** The same operation hash was recorded twice. Also a store-level constraint. */
export class DuplicateOperationError extends PayoutEngineError {
  constructor(readonly opHash: string) {
    super(`operation ${opHash} is already recorded — refusing to record it twice`);
  }
}

/**
 * The run stopped and a human has to look. Never a retry: the whole point of
 * this state is that "try again just in case" is what pays twice.
 */
export class PayoutBlockedError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly cycle: number,
    reason: string,
  ) {
    super(
      `${bakerId} cycle ${cycle} is blocked for human review: ${reason} — ` +
        'no operation will be resent automatically',
    );
  }
}

/**
 * A destination that is not a delegator of this cycle.
 *
 * The remote signer removes key exfiltration, not key misuse: anyone with
 * execution on the TAPS host can ask for a transfer to their own address and
 * the signer will sign it, because it is a valid generic operation. The
 * defence is here, before the signing request leaves.
 */
export class DestinationNotAllowedError extends PayoutEngineError {
  constructor(
    readonly address: string,
    readonly bakerId: string,
    readonly cycle: number,
  ) {
    super(
      `${address} is not a delegator of ${bakerId} in cycle ${cycle} — ` +
        'refusing to request a signature for it',
    );
  }
}

/** The run would move more than the configured ceiling for one cycle. */
export class CycleCapExceededError extends PayoutEngineError {
  constructor(
    readonly totalMutez: bigint,
    readonly capMutez: bigint,
    readonly cycle: number,
  ) {
    super(
      `cycle ${cycle} would move ${totalMutez} mutez, over the configured ceiling of ` +
        `${capMutez} mutez — explicit human approval required`,
    );
  }
}

/**
 * A recipient that needs its account allocated was planned with storage that
 * cannot pay the allocation burn. Simulated on mainnet: in a batch of three,
 * one unallocated destination leaves ALL THREE `backtracked`, and the two
 * good ones carry no error of their own.
 */
export class StorageAllocationError extends PayoutEngineError {
  constructor(
    readonly address: string,
    readonly storageLimit: bigint,
    readonly required: bigint,
  ) {
    super(
      `${address} needs its account allocated and was planned with storage_limit ` +
        `${storageLimit}, below origination_size ${required} — the whole batch would ` +
        'come back backtracked and nobody would be paid',
    );
  }
}

/** The cycle can still be reduced by a denunciation. Paying now overpays. */
export class CycleNotDistributableError extends PayoutEngineError {
  constructor(
    readonly cycle: number,
    readonly headCycle: number,
    readonly firstDistributableCycle: number,
  ) {
    super(
      `cycle ${cycle} is distributable from cycle ${firstDistributableCycle} on, and the ` +
        `chain is at ${headCycle} — a denunciation can still reduce the reward`,
    );
  }
}

/** An estimate was asked for an address the estimation pass never covered. */
export class MissingEstimateError extends PayoutEngineError {
  constructor(readonly address: string) {
    super(
      `no estimated transfer cost for ${address} — the minimum payout is the estimated ` +
        'fee of this very transfer and has no constant to fall back on',
    );
  }
}

/**
 * The run could not decide, within its polling budget, whether an operation
 * landed. The distribution stays `sending` and the next run resumes it.
 *
 * This is deliberately NOT `blocked`: nothing is inconsistent, the chain has
 * simply not answered yet. Before the branch's time to live is over, absence
 * from the mempool proves nothing, and treating it as "never injected" is the
 * exact step that pays twice.
 */
export class PayoutUnresolvedError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly cycle: number,
    readonly opHash: string,
    readonly status: string,
  ) {
    super(
      `${bakerId} cycle ${cycle}: operation ${opHash} is still "${status}" after the ` +
        'polling budget — the distribution stays open and will be resumed, never resent',
    );
  }
}
