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
    readonly cycle: number | null,
    reason: string,
  ) {
    super(
      `${bakerId} ${where(cycle)} is blocked for human review: ${reason} — ` +
        'no operation will be resent automatically',
    );
  }
}

/**
 * A cycle number, or the absence of one.
 *
 * The debt settlement of RN-24 belongs to no cycle — that is the point of it
 * — and writing `cycle -1` into an operator-facing message would be a
 * sentinel pretending to be a fact.
 */
function where(cycle: number | null): string {
  return cycle === null ? 'an out-of-cycle debt settlement' : `cycle ${cycle}`;
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
    readonly cycle: number | null,
  ) {
    super(
      `${address} is not a destination ${bakerId} planned for ${where(cycle)} — ` +
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
    readonly cycle: number | null,
    readonly opHash: string,
    readonly status: string,
  ) {
    super(
      `${bakerId} ${where(cycle)}: operation ${opHash} is still "${status}" after the ` +
        'polling budget — the distribution stays open and will be resumed, never resent',
    );
  }
}

/**
 * K is not a number this system may guess. Below 1 it would send payments
 * that cost more than they carry; a zero denominator is not a ratio at all.
 */
export class InvalidPayoutFactorError extends PayoutEngineError {
  constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
    reason: string,
  ) {
    super(
      `K = ${numerator}/${denominator} is not a usable payout factor: ${reason} — ` +
        'RN-24 pays only what covers K times the estimated transfer cost',
    );
  }
}

/**
 * More cycles are owed than the baker allowed to run unattended (RN-28).
 *
 * Not a failure: the cycles are still owed, still recorded, and nothing was
 * injected. It is the alarm that exists for one concrete scenario — coming
 * back from a trip to find the wallet emptied in one go because the system
 * decided on its own to pay a week of cycles.
 */
export class OwedCyclesExceededError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly owed: readonly number[],
    readonly maxOwedCycles: number,
  ) {
    super(
      `${bakerId} has ${owed.length} cycles owed (${owed.join(', ')}), over the configured ` +
        `limit of ${maxOwedCycles} — nothing was injected; a human decides before any of ` +
        'them is paid',
    );
  }
}

/**
 * A debt settlement was asked for an address that owes nothing.
 *
 * Raised rather than skipped: the caller named an address on purpose, and a
 * settlement that quietly pays nobody is the silent-success failure mode this
 * engine exists to remove.
 */
export class NoOpenDebtError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly address: string,
  ) {
    super(
      `${bakerId} carries no open debt for ${address} — there is nothing to settle, ` +
        'and paying zero would be a transfer that costs a fee and moves nothing',
    );
  }
}

/** The same settlement id was created twice. A store-level constraint. */
export class DuplicateSettlementError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly settlementId: string,
  ) {
    super(
      `${bakerId} already has a debt settlement called ${settlementId} — ` +
        'a second one under the same name would pay the same debt again',
    );
  }
}

/**
 * A cycle was about to be planned while a debt settlement is in flight.
 *
 * The mirror of `SettlementWindowError`. Planning reads the carry-over, and
 * the settlement is already paying part of it without having cleared anything
 * yet — so both would pay the same debt. Only PLANNING is refused: a
 * distribution already under way resumes normally, because its amounts were
 * fixed before the settlement existed.
 */
export class OpenSettlementError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly settlementIds: readonly string[],
  ) {
    super(
      `${bakerId} has debt settlement(s) ${settlementIds.join(', ')} in flight — planning a ` +
        'cycle now would read a balance one of them is already paying, and pay it twice',
    );
  }
}

/** A debt settlement would move more than the baker's configured ceiling. */
export class SettlementCapExceededError extends PayoutEngineError {
  constructor(
    readonly totalMutez: bigint,
    readonly capMutez: bigint,
    readonly settlementId: string,
  ) {
    super(
      `debt settlement ${settlementId} would move ${totalMutez} mutez, over the configured ` +
        `ceiling of ${capMutez} mutez — explicit human approval required`,
    );
  }
}

/**
 * A settlement was asked for while a cycle distribution is still open.
 *
 * The open distribution has already read the carry-over it is going to pay.
 * Settling the same debt now would pay it twice — once here and once when
 * that distribution lands.
 */
export class SettlementWindowError extends PayoutEngineError {
  constructor(
    readonly bakerId: string,
    readonly cycles: readonly number[],
  ) {
    super(
      `${bakerId} has open distributions for cycle(s) ${cycles.join(', ')} — settling a debt ` +
        'now could pay it twice, because those runs already read the balance being settled',
    );
  }
}

/**
 * The estimation toolkit was asked for a signature.
 *
 * Estimation is a node simulation: Taquito forges the batch and sends it to
 * `run_operation` under a stub signature, so nothing on that path ever needs
 * a real one. The only signature this system produces is
 * `OctezRemoteSigner.signOperation` — `0x03 || forged bytes`, over TLS, to a
 * signer started with `--magic-bytes 0x03` — and it is asked for by
 * `RpcBatchInjector` after the forged bytes have been parsed back and checked
 * against the plan.
 *
 * So this error is not a missing feature. It is the boundary saying that a
 * caller reached a signing capability from the side of the code that is not
 * allowed to move money, and the fix is to route through the injector, never
 * to teach this signer to sign.
 */
export class EstimationSignerCannotSignError extends PayoutEngineError {
  constructor(readonly operation: 'sign' | 'secretKey' | 'provePossession') {
    super(
      `the estimation path called ${operation}() — it has no signing capability and will ` +
        'never get one: estimation is simulated under a stub signature, and the only real ' +
        'signature in this system is asked for by RpcBatchInjector, over bytes it forged ' +
        'and parsed back',
    );
  }
}

/**
 * The payout account has no `manager_key` on chain.
 *
 * An implicit account that has never been revealed cannot emit a transaction
 * at all, so no cycle can be paid from it. TAPS refuses here instead of
 * letting Taquito prepend a reveal of its own accord, for two reasons: the
 * injector forges transactions only, so a reveal planned during estimation
 * would never be injected and every fee would be wrong; and revealing
 * publishes the payout public key, which is a one-time act by the operator,
 * not something a scheduler decides at 3am.
 */
export class PayoutAccountNotRevealedError extends PayoutEngineError {
  constructor(readonly publicKeyHash: string) {
    super(
      `${publicKeyHash} has no manager_key on chain and the signer did not offer a ` +
        'public key either — so nothing can say which key this account signs with, and ' +
        'no operation can be built. Confirm the payout address matches the key the ' +
        'signer holds. TAPS reveals the account itself when the signer answers ' +
        '(BRES-137), as its own operation and never inside a payout batch: a batch that ' +
        'carried one could not be rebuilt from the store on a resume, and the hash ' +
        'written before the operation exists is what makes a retry safe',
    );
  }
}
