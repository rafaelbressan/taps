import { InvariantViolationError, type Mutez } from '@tezos-suite/chain';
import {
  DuplicateDistributionError,
  DuplicateOperationError,
  DuplicateSettlementError,
} from '../errors';
import type {
  AuditEvent,
  BatchRecord,
  BatchStatusUpdate,
  DebtSettlementRecord,
  DelegatorLineRecord,
  DistributionRecord,
  DistributionSnapshot,
  DistributionStatus,
  InjectionIntent,
  NewDebtSettlement,
  NewDistribution,
  PayoutStore,
  Settlement,
  SettlementIntent,
  SettlementStatusUpdate,
  StoredAuditEvent,
} from './types';

/** The store's whole contents, in a shape a file or a table can hold. */
export interface StoreState {
  readonly distributions: readonly {
    readonly id: string;
    readonly distribution: DistributionRecord;
    readonly lines: readonly DelegatorLineRecord[];
    readonly batches: readonly BatchRecord[];
  }[];
  readonly carryOver: readonly {
    readonly bakerId: string;
    readonly balances: readonly (readonly [string, Mutez])[];
  }[];
  readonly operationHashes: readonly (readonly [string, string])[];
  readonly settlements: readonly DebtSettlementRecord[];
  readonly audit: readonly StoredAuditEvent[];
}

interface DistributionState {
  distribution: DistributionRecord;
  lines: Map<string, DelegatorLineRecord>;
  batches: Map<number, BatchRecord>;
}

function key(bakerId: string, cycle: number): string {
  return `${bakerId}#${cycle}`;
}

function settlementKey(bakerId: string, settlementId: string): string {
  return `${bakerId}#settlement:${settlementId}`;
}

/**
 * The reference implementation of `PayoutStore`.
 *
 * It enforces the same constraints the database has to enforce — one
 * distribution per `(bakerId, cycle)`, one record per operation hash, and
 * all-or-nothing settlement — so a test can prove the CONTRACT is what stops
 * a duplicate payment, not a particular engine's control flow.
 *
 * Writes that touch several records build the new state first and swap it in
 * at the end. A half-written settlement is not representable.
 */
export class InMemoryPayoutStore implements PayoutStore {
  private readonly distributions = new Map<string, DistributionState>();
  private readonly carryOver = new Map<string, Map<string, Mutez>>();
  private readonly operationHashes = new Map<string, string>();
  private readonly settlements = new Map<string, DebtSettlementRecord>();
  private readonly audit: StoredAuditEvent[] = [];

  async getDistribution(
    bakerId: string,
    cycle: number,
  ): Promise<DistributionSnapshot | undefined> {
    const state = this.distributions.get(key(bakerId, cycle));
    if (!state) return undefined;
    return snapshotOf(state);
  }

  async getBatch(
    bakerId: string,
    cycle: number,
    index: number,
  ): Promise<BatchRecord | undefined> {
    return this.distributions.get(key(bakerId, cycle))?.batches.get(index);
  }

  async createDistribution(input: NewDistribution): Promise<DistributionSnapshot> {
    const { bakerId, cycle } = input.distribution;
    const id = key(bakerId, cycle);
    if (this.distributions.has(id)) {
      throw new DuplicateDistributionError(bakerId, cycle);
    }

    const now = new Date();
    const lines = new Map<string, DelegatorLineRecord>();
    for (const line of input.lines) {
      if (lines.has(line.address)) {
        throw new InvariantViolationError(
          'one delegator line per address per cycle',
          `${bakerId} cycle ${cycle} lists ${line.address} twice`,
        );
      }
      lines.set(line.address, { ...line, batchIndex: null, opHash: null, result: 'planned' });
    }

    const batches = new Map<number, BatchRecord>();
    for (const batch of input.batches) {
      if (batches.has(batch.index)) {
        throw new InvariantViolationError(
          'one record per batch index',
          `${bakerId} cycle ${cycle} lists batch ${batch.index} twice`,
        );
      }
      batches.set(batch.index, {
        ...batch,
        status: 'pending',
        opHash: null,
        counter: null,
        branch: null,
        branchLevel: null,
        attempts: [],
        injectedAt: null,
        includedLevel: null,
        confirmedAt: null,
        error: null,
      });
    }

    const state: DistributionState = {
      distribution: {
        ...input.distribution,
        status: 'planned',
        createdAt: now,
        updatedAt: now,
      },
      lines,
      batches,
    };
    this.distributions.set(id, state);
    return snapshotOf(state);
  }

  async listCycleStatuses(bakerId: string): Promise<Map<number, DistributionStatus>> {
    const statuses = new Map<number, DistributionStatus>();
    for (const state of this.distributions.values()) {
      if (state.distribution.bakerId !== bakerId) continue;
      statuses.set(state.distribution.cycle, state.distribution.status);
    }
    return statuses;
  }

  async loadCarryOver(bakerId: string): Promise<Map<string, Mutez>> {
    return new Map(this.carryOver.get(bakerId) ?? []);
  }

  async recordInjectionIntent(intent: InjectionIntent): Promise<void> {
    const owner = this.operationHashes.get(intent.opHash);
    const self = `${key(intent.bakerId, intent.cycle)}/${intent.index}`;
    if (owner !== undefined && owner !== self) {
      throw new DuplicateOperationError(intent.opHash);
    }

    const state = this.requireState(intent.bakerId, intent.cycle);
    const batch = state.batches.get(intent.index);
    if (!batch) {
      throw new InvariantViolationError(
        'the batch being injected was planned',
        `${self} has no planned batch`,
      );
    }
    // An earlier hash is never dropped. It is the evidence that the money may
    // already have left, and the failure this engine exists to remove starts
    // with deleting it: a fresh attempt is APPENDED, and only once the chain
    // has said the previous one can never land.
    if (batch.opHash !== null && batch.opHash !== intent.opHash) {
      if (batch.status !== 'expired' && batch.status !== 'failed') {
        throw new InvariantViolationError(
          'a new attempt needs the previous one expired or failed',
          `${self} carries ${batch.opHash} in state "${batch.status}"; ` +
            `recording ${intent.opHash} now could pay the same delegators twice`,
        );
      }
    }

    this.operationHashes.set(intent.opHash, self);
    state.batches.set(intent.index, {
      ...batch,
      status: 'pending',
      opHash: intent.opHash,
      counter: intent.counter,
      branch: intent.branch,
      branchLevel: intent.branchLevel,
      attempts:
        batch.opHash === intent.opHash ? batch.attempts : [...batch.attempts, intent],
      injectedAt: intent.at,
    });
    state.distribution = { ...state.distribution, status: 'sending', updatedAt: intent.at };
  }

  async recordBatchStatus(update: BatchStatusUpdate): Promise<void> {
    const state = this.requireState(update.bakerId, update.cycle);
    const batch = state.batches.get(update.index);
    if (!batch) {
      throw new InvariantViolationError(
        'the batch being updated exists',
        `${key(update.bakerId, update.cycle)}/${update.index} was never planned`,
      );
    }
    state.batches.set(update.index, {
      ...batch,
      status: update.status,
      includedLevel: update.includedLevel ?? batch.includedLevel,
      confirmedAt: update.confirmedAt ?? batch.confirmedAt,
      error: update.error ?? batch.error,
    });
    state.distribution = { ...state.distribution, updatedAt: new Date() };
  }

  async setDistributionStatus(
    bakerId: string,
    cycle: number,
    status: DistributionStatus,
    at: Date,
  ): Promise<void> {
    const state = this.requireState(bakerId, cycle);
    state.distribution = { ...state.distribution, status, updatedAt: at };
  }

  async settleDistribution(settlement: Settlement): Promise<void> {
    const state = this.requireState(settlement.bakerId, settlement.cycle);

    // Build first, commit last: a settlement that raises halfway leaves the
    // store exactly as it was.
    const lines = new Map(state.lines);
    for (const line of settlement.lines) {
      const existing = lines.get(line.address);
      if (!existing) {
        throw new InvariantViolationError(
          'settling a delegator that was planned',
          `${settlement.bakerId} cycle ${settlement.cycle} has no line for ${line.address}`,
        );
      }
      lines.set(line.address, {
        ...existing,
        result: line.result,
        batchIndex: line.batchIndex,
        opHash: line.opHash,
      });
    }

    const carry = new Map(this.carryOver.get(settlement.bakerId) ?? []);
    for (const [address, balance] of settlement.carryOver) {
      if (balance < 0n) {
        throw new InvariantViolationError(
          'carry-over balance >= 0',
          `${address} would carry ${balance} mutez`,
        );
      }
      if (balance === 0n) carry.delete(address);
      else carry.set(address, balance);
    }

    state.lines = lines;
    state.distribution = {
      ...state.distribution,
      status: settlement.status,
      updatedAt: settlement.at,
    };
    this.carryOver.set(settlement.bakerId, carry);
  }

  async createDebtSettlement(input: NewDebtSettlement): Promise<DebtSettlementRecord> {
    const id = settlementKey(input.bakerId, input.settlementId);
    if (this.settlements.has(id)) {
      throw new DuplicateSettlementError(input.bakerId, input.settlementId);
    }
    if (input.lines.length === 0) {
      throw new InvariantViolationError(
        'a debt settlement pays at least one address',
        `${input.bakerId} asked for ${input.settlementId} with no lines`,
      );
    }

    const now = new Date();
    const record: DebtSettlementRecord = {
      ...input,
      status: 'planned',
      opHash: null,
      counter: null,
      branch: null,
      branchLevel: null,
      attempts: [],
      injectedAt: null,
      includedLevel: null,
      confirmedAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.settlements.set(id, record);
    return record;
  }

  async getDebtSettlement(
    bakerId: string,
    settlementId: string,
  ): Promise<DebtSettlementRecord | undefined> {
    return this.settlements.get(settlementKey(bakerId, settlementId));
  }

  async listOpenSettlements(bakerId: string): Promise<readonly string[]> {
    return [...this.settlements.values()]
      .filter(
        (record) =>
          record.bakerId === bakerId &&
          (record.status === 'planned' || record.status === 'sending'),
      )
      .map((record) => record.settlementId)
      .sort();
  }

  async recordSettlementIntent(intent: SettlementIntent): Promise<void> {
    const self = settlementKey(intent.bakerId, intent.settlementId);
    const owner = this.operationHashes.get(intent.opHash);
    if (owner !== undefined && owner !== self) {
      throw new DuplicateOperationError(intent.opHash);
    }

    const record = this.requireSettlement(intent.bakerId, intent.settlementId);
    // Same rule as a cycle batch: an earlier hash is evidence the money may
    // already have left, so a second attempt is only recordable once the
    // chain has said the first one can never land.
    if (record.opHash !== null && record.opHash !== intent.opHash) {
      if (record.status !== 'failed') {
        throw new InvariantViolationError(
          'a new settlement attempt needs the previous one failed',
          `${self} carries ${record.opHash} in state "${record.status}"; ` +
            `recording ${intent.opHash} now could pay the same debt twice`,
        );
      }
    }

    this.operationHashes.set(intent.opHash, self);
    this.settlements.set(self, {
      ...record,
      status: 'sending',
      opHash: intent.opHash,
      counter: intent.counter,
      branch: intent.branch,
      branchLevel: intent.branchLevel,
      attempts:
        record.opHash === intent.opHash ? record.attempts : [...record.attempts, intent],
      injectedAt: intent.at,
      updatedAt: intent.at,
    });
  }

  async recordSettlementStatus(update: SettlementStatusUpdate): Promise<void> {
    const record = this.requireSettlement(update.bakerId, update.settlementId);

    if (update.cleared && update.cleared.length > 0 && update.status !== 'settled') {
      throw new InvariantViolationError(
        'a debt is only cleared by a settled settlement',
        `${update.settlementId} tried to clear ${update.cleared.length} debt(s) while ` +
          `"${update.status}" — an unconfirmed clear is a debt silently forgiven`,
      );
    }

    // Build first, commit last: the status and the cleared debts land together
    // or not at all.
    const carry = new Map(this.carryOver.get(update.bakerId) ?? []);
    for (const address of update.cleared ?? []) {
      const owed = carry.get(address);
      if (owed === undefined) {
        throw new InvariantViolationError(
          'clearing a debt that is on record',
          `${update.bakerId} carries no debt for ${address}`,
        );
      }
      const line = record.lines.find((entry) => entry.address === address);
      if (!line || line.amountMutez !== owed) {
        throw new InvariantViolationError(
          'the settled amount is exactly the debt on record',
          `${address}: settlement paid ${line?.amountMutez ?? 'nothing'}, store carries ${owed}`,
        );
      }
      carry.delete(address);
    }

    this.settlements.set(settlementKey(update.bakerId, update.settlementId), {
      ...record,
      status: update.status,
      includedLevel: update.includedLevel ?? record.includedLevel,
      confirmedAt: update.confirmedAt ?? record.confirmedAt,
      error: update.error ?? record.error,
      updatedAt: update.at,
    });
    this.carryOver.set(update.bakerId, carry);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push({ ...event, id: this.audit.length + 1 });
  }

  async listAudit(bakerId: string, cycle?: number): Promise<StoredAuditEvent[]> {
    return this.audit.filter(
      (event) =>
        event.bakerId === bakerId && (cycle === undefined || event.cycle === cycle),
    );
  }

  /**
   * The whole state, for a durable wrapper to write down. Kept here rather
   * than reimplemented next to a file or a table so that the constraints
   * above have exactly one implementation and one set of tests.
   */
  snapshotState(): StoreState {
    return {
      distributions: [...this.distributions.entries()].map(([id, state]) => ({
        id,
        distribution: state.distribution,
        lines: [...state.lines.values()],
        batches: [...state.batches.values()],
      })),
      carryOver: [...this.carryOver.entries()].map(([bakerId, balances]) => ({
        bakerId,
        balances: [...balances.entries()],
      })),
      operationHashes: [...this.operationHashes.entries()],
      settlements: [...this.settlements.values()],
      audit: [...this.audit],
    };
  }

  /** The inverse of `snapshotState`. Replaces everything the store holds. */
  restoreState(state: StoreState): void {
    this.distributions.clear();
    this.carryOver.clear();
    this.operationHashes.clear();
    this.settlements.clear();
    this.audit.length = 0;

    for (const entry of state.distributions) {
      this.distributions.set(entry.id, {
        distribution: entry.distribution,
        lines: new Map(entry.lines.map((line) => [line.address, line])),
        batches: new Map(entry.batches.map((batch) => [batch.index, batch])),
      });
    }
    for (const entry of state.carryOver) {
      this.carryOver.set(entry.bakerId, new Map(entry.balances));
    }
    for (const [hash, owner] of state.operationHashes) {
      this.operationHashes.set(hash, owner);
    }
    // A store written before debt settlements existed has no `settlements`
    // key. Reading it back is not the moment to invent one, but it IS the
    // moment where an absent list means "none were ever made".
    for (const settlement of state.settlements ?? []) {
      this.settlements.set(
        settlementKey(settlement.bakerId, settlement.settlementId),
        settlement,
      );
    }
    this.audit.push(...state.audit);
  }

  private requireSettlement(bakerId: string, settlementId: string): DebtSettlementRecord {
    const record = this.settlements.get(settlementKey(bakerId, settlementId));
    if (!record) {
      throw new InvariantViolationError(
        'the settlement being written was created',
        `${bakerId} has no debt settlement called ${settlementId}`,
      );
    }
    return record;
  }

  private requireState(bakerId: string, cycle: number): DistributionState {
    const state = this.distributions.get(key(bakerId, cycle));
    if (!state) {
      throw new InvariantViolationError(
        'the distribution being written was created',
        `${bakerId} has no distribution for cycle ${cycle}`,
      );
    }
    return state;
  }
}

function snapshotOf(state: DistributionState): DistributionSnapshot {
  return {
    distribution: state.distribution,
    lines: [...state.lines.values()],
    batches: [...state.batches.values()].sort((a, b) => a.index - b.index),
  };
}
