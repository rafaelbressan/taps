import type { Mutez } from '@tezos-suite/chain';

/**
 * The persistence contract of the payout engine.
 *
 * It is a port, not a database, for one reason: the properties that make a
 * payout safe — "one distribution per (baker, cycle)", "the operation hash is
 * written before the operation is injected", "the whole settlement lands or
 * none of it does" — are properties of the CONTRACT. Any implementation that
 * cannot enforce them is not an implementation of this interface, and the
 * in-memory one in this package exists so the tests prove the contract rather
 * than prove Postgres.
 */

export type DistributionStatus =
  /** Planned and persisted; nothing injected yet. */
  | 'planned'
  /** At least one batch is in flight. */
  | 'sending'
  /** Every batch confirmed; delegator lines and carry-over written. */
  | 'settled'
  /** Gave up with a chain-level failure; safe to plan again. */
  | 'failed'
  /** A human must look. Never resumed automatically. */
  | 'blocked';

export type BatchStatus =
  /** Hash recorded, injection not yet acknowledged. Money may already be gone. */
  | 'pending'
  /** The node accepted the injection. */
  | 'injected'
  /** Found in a block, applied. */
  | 'included'
  /** Two levels deep and re-read. */
  | 'confirmed'
  /** In a block with a status other than applied. */
  | 'failed'
  /** Past the branch's time to live and never seen. The only safe resend. */
  | 'expired';

export type LineResult = 'planned' | 'applied' | 'deferred' | 'failed';

export interface DistributionRecord {
  readonly bakerId: string;
  readonly cycle: number;
  readonly status: DistributionStatus;

  readonly network: string;
  readonly protocolHash: string;

  readonly pool: Mutez;
  readonly ownShare: Mutez;
  readonly bakerFee: Mutez;
  readonly distributable: Mutez;
  readonly remainder: Mutez;
  readonly totalToSend: Mutez;

  readonly feeNumerator: bigint;
  readonly feeDenominator: bigint;
  readonly blockFeesIncluded: boolean;

  /**
   * K, the payout factor of RN-24, exactly as it was applied this cycle.
   *
   * Recorded for the same reason `minimumMutez` is recorded per line: the cut
   * is `K × estimated cost`, and once the cycle is over neither half can be
   * recovered from the chain. Without K written down, the cut of a past cycle
   * stops being explainable — which is the whole reason the column exists.
   */
  readonly payoutFactorNumerator: bigint;
  readonly payoutFactorDenominator: bigint;

  readonly delegatorCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DelegatorLineRecord {
  readonly bakerId: string;
  readonly cycle: number;
  readonly address: string;
  /** Snapshot balance the share was computed from. */
  readonly delegatedBalanceMutez: Mutez;

  readonly grossMutez: Mutez;
  readonly commissionMutez: Mutez;
  readonly netMutez: Mutez;
  readonly carriedInMutez: Mutez;
  readonly payableMutez: Mutez;
  /**
   * What one transfer to this address cost, as estimated this cycle: fee plus
   * the allocation burn when the destination had to be created. Zero for a
   * delegator with nothing owed, who was never priced.
   */
  readonly transferCostMutez: Mutez;
  /**
   * The cut applied this cycle — `K × transferCostMutez`, rounded up. Not
   * reproducible later: the network fee moves, and nothing on chain records
   * what the estimate was.
   */
  readonly minimumMutez: Mutez;
  readonly withheldMutez: Mutez;
  readonly amountMutez: Mutez;
  readonly carriedOutMutez: Mutez;

  readonly emptied: boolean;
  readonly batchIndex: number | null;
  readonly opHash: string | null;
  readonly result: LineResult;
}

export interface PersistedTransfer {
  readonly address: string;
  readonly amountMutez: Mutez;
  readonly feeMutez: Mutez;
  readonly gasLimit: bigint;
  readonly storageLimit: bigint;
  readonly burnMutez: Mutez;
}

export interface BatchRecord {
  readonly bakerId: string;
  readonly cycle: number;
  readonly index: number;
  readonly status: BatchStatus;

  /** Current attempt's hash, written BEFORE injection. */
  readonly opHash: string | null;
  readonly counter: string | null;
  readonly branch: string | null;
  readonly branchLevel: number | null;
  /**
   * Every attempt ever made, in order, append-only. A resend after expiry
   * uses a fresh branch and therefore a fresh hash; the old one still has to
   * survive, because it is the record of an operation that may have landed
   * after all.
   */
  readonly attempts: readonly InjectionIntent[];

  /**
   * Every transfer with the gas, storage and fee THIS run estimated for it.
   * Not an average: an averaged storage limit is `storage_limit: 0` wearing a
   * different number, and one destination that needs allocating takes the
   * whole batch down with it.
   */
  readonly transfers: readonly PersistedTransfer[];

  readonly totalAmount: Mutez;
  readonly totalFees: Mutez;
  readonly totalBurn: Mutez;
  readonly totalGas: bigint;
  readonly totalStorage: bigint;

  readonly injectedAt: Date | null;
  readonly includedLevel: number | null;
  readonly confirmedAt: Date | null;
  readonly error: string | null;
}

export interface DistributionSnapshot {
  readonly distribution: DistributionRecord;
  readonly lines: readonly DelegatorLineRecord[];
  readonly batches: readonly BatchRecord[];
}

export interface NewDistribution {
  readonly distribution: Omit<DistributionRecord, 'createdAt' | 'updatedAt' | 'status'>;
  readonly lines: readonly Omit<DelegatorLineRecord, 'batchIndex' | 'opHash' | 'result'>[];
  readonly batches: readonly Omit<
    BatchRecord,
    | 'status'
    | 'opHash'
    | 'counter'
    | 'branch'
    | 'branchLevel'
    | 'attempts'
    | 'injectedAt'
    | 'includedLevel'
    | 'confirmedAt'
    | 'error'
  >[];
}

/**
 * The write that has to happen before the operation reaches the node.
 *
 * The current TAPS has the mirror image of this: `clearPreviousAttempt()`
 * deletes the record of the first attempt, so after a lost confirmation there
 * is nothing left saying the money may have moved.
 */
export interface InjectionIntent {
  readonly bakerId: string;
  readonly cycle: number;
  readonly index: number;
  readonly opHash: string;
  readonly counter: string;
  readonly branch: string;
  readonly branchLevel: number;
  readonly at: Date;
}

export interface BatchStatusUpdate {
  readonly bakerId: string;
  readonly cycle: number;
  readonly index: number;
  readonly status: BatchStatus;
  readonly includedLevel?: number | null;
  readonly confirmedAt?: Date | null;
  readonly error?: string | null;
}

export interface LineSettlement {
  readonly address: string;
  readonly result: LineResult;
  readonly batchIndex: number | null;
  readonly opHash: string | null;
}

export interface Settlement {
  readonly bakerId: string;
  readonly cycle: number;
  readonly status: DistributionStatus;
  readonly lines: readonly LineSettlement[];
  /** Balance to carry into the next cycle, per address. Zero clears the row. */
  readonly carryOver: ReadonlyMap<string, Mutez>;
  readonly at: Date;
}

/**
 * Paying off an open debt on request (RN-24, borda 1).
 *
 * A delegator who stops delegating with a balance below the cut never earns
 * again, so the balance never grows and never clears the cut on its own. The
 * debt is the baker's and does not expire because the delegator went quiet:
 * the only honest way out is an explicit, recorded, human-asked payment that
 * accepts costing more in fee than it moves.
 *
 * It is deliberately NOT a cycle distribution: it belongs to no cycle, it
 * must not appear in a cycle's reconciliation, and it must not be reachable
 * by the automatic path. It keeps the one property that matters, though —
 * the operation hash is durable before the operation exists.
 */
export type DebtSettlementStatus =
  | 'planned'
  | 'sending'
  | 'settled'
  | 'failed'
  | 'blocked';

export interface DebtSettlementLine {
  readonly address: string;
  /** The open debt being paid, in mutez. Exactly what was carried over. */
  readonly amountMutez: Mutez;
  readonly feeMutez: Mutez;
  readonly gasLimit: bigint;
  readonly storageLimit: bigint;
  readonly burnMutez: Mutez;
}

export interface DebtSettlementRecord {
  readonly bakerId: string;
  /** Caller-chosen, unique per baker. This is the idempotency key. */
  readonly settlementId: string;
  readonly status: DebtSettlementStatus;

  readonly network: string;
  readonly protocolHash: string;
  /** Who asked, and why. Verbatim in the audit trail. */
  readonly actor: string;
  readonly reason: string;

  readonly lines: readonly DebtSettlementLine[];
  readonly totalAmount: Mutez;
  readonly totalFees: Mutez;
  readonly totalBurn: Mutez;

  readonly opHash: string | null;
  readonly counter: string | null;
  readonly branch: string | null;
  readonly branchLevel: number | null;
  readonly attempts: readonly SettlementIntent[];

  readonly injectedAt: Date | null;
  readonly includedLevel: number | null;
  readonly confirmedAt: Date | null;
  readonly error: string | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewDebtSettlement = Omit<
  DebtSettlementRecord,
  | 'status'
  | 'opHash'
  | 'counter'
  | 'branch'
  | 'branchLevel'
  | 'attempts'
  | 'injectedAt'
  | 'includedLevel'
  | 'confirmedAt'
  | 'error'
  | 'createdAt'
  | 'updatedAt'
>;

/** The settlement's equivalent of `InjectionIntent`: durable before injection. */
export interface SettlementIntent {
  readonly bakerId: string;
  readonly settlementId: string;
  readonly opHash: string;
  readonly counter: string;
  readonly branch: string;
  readonly branchLevel: number;
  readonly at: Date;
}

export interface SettlementStatusUpdate {
  readonly bakerId: string;
  readonly settlementId: string;
  readonly status: DebtSettlementStatus;
  readonly includedLevel?: number | null;
  readonly confirmedAt?: Date | null;
  readonly error?: string | null;
  /**
   * Addresses whose debt this settlement cleared. Written in the SAME
   * transaction as the status, and only on `settled`: a debt cleared without
   * a confirmed operation is a debt silently forgiven.
   */
  readonly cleared?: readonly string[];
  readonly at: Date;
}

export type AuditOutcome = 'ok' | 'refused' | 'error';

/**
 * Who fired it, when, from where, with what parameters, and what happened.
 * None of this exists in the current TAPS — there is no audit table at all.
 */
export interface AuditEvent {
  readonly at: Date;
  readonly bakerId: string;
  readonly cycle: number | null;
  readonly actor: string;
  readonly source: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly params: Readonly<Record<string, unknown>>;
  readonly opHash?: string | null;
  readonly destinations?: readonly string[];
  readonly amountMutez?: Mutez | null;
  readonly detail?: string;
}

export interface StoredAuditEvent extends AuditEvent {
  readonly id: number;
}

export interface PayoutStore {
  getDistribution(bakerId: string, cycle: number): Promise<DistributionSnapshot | undefined>;

  /** One batch, without materialising every delegator line of the cycle. */
  getBatch(
    bakerId: string,
    cycle: number,
    index: number,
  ): Promise<BatchRecord | undefined>;

  /**
   * One transaction. Raises `DuplicateDistributionError` when this
   * `(bakerId, cycle)` already exists — the constraint that makes a duplicate
   * payment impossible rather than improbable.
   */
  createDistribution(input: NewDistribution): Promise<DistributionSnapshot>;

  /**
   * The status of every cycle this baker has a distribution for.
   *
   * The queue of RN-28 needs to know which cycles are already settled and
   * which are not, and it needs it without materialising every delegator line
   * of every cycle. Absence from this map means "never planned", which for a
   * distributable cycle means "owed".
   */
  listCycleStatuses(bakerId: string): Promise<Map<number, DistributionStatus>>;

  /** Unpaid balances owed to delegators of this baker, from earlier cycles. */
  loadCarryOver(bakerId: string): Promise<Map<string, Mutez>>;

  /**
   * Durable before the caller injects. Raises on a hash already recorded
   * elsewhere, and on a new attempt for a batch whose previous attempt is not
   * yet `expired` or `failed` — the chain, not the caller, decides that.
   */
  recordInjectionIntent(intent: InjectionIntent): Promise<void>;

  recordBatchStatus(update: BatchStatusUpdate): Promise<void>;

  /** Moves the distribution's own state without touching lines or balances. */
  setDistributionStatus(
    bakerId: string,
    cycle: number,
    status: DistributionStatus,
    at: Date,
  ): Promise<void>;

  /** One transaction: line results, distribution status and carry-over. */
  settleDistribution(settlement: Settlement): Promise<void>;

  /**
   * One transaction. Raises `DuplicateSettlementError` when this
   * `(bakerId, settlementId)` already exists — the constraint that makes the
   * same debt payable exactly once by this path.
   */
  createDebtSettlement(input: NewDebtSettlement): Promise<DebtSettlementRecord>;

  getDebtSettlement(
    bakerId: string,
    settlementId: string,
  ): Promise<DebtSettlementRecord | undefined>;

  /**
   * Settlements that are planned or in flight.
   *
   * A cycle distribution must not be PLANNED while one of these is open: the
   * plan reads the carry-over, the settlement is already paying part of it,
   * and neither has cleared anything yet. Both would pay the same debt.
   */
  listOpenSettlements(bakerId: string): Promise<readonly string[]>;

  /** Same contract as `recordInjectionIntent`, over the same hash namespace. */
  recordSettlementIntent(intent: SettlementIntent): Promise<void>;

  /** One transaction: settlement status and, on `settled`, the cleared debts. */
  recordSettlementStatus(update: SettlementStatusUpdate): Promise<void>;

  appendAudit(event: AuditEvent): Promise<void>;

  listAudit(bakerId: string, cycle?: number): Promise<StoredAuditEvent[]>;
}
