import { InvariantViolationError, type Mutez } from '@tezos-suite/chain';
import { DuplicateDistributionError, DuplicateOperationError } from '../errors';
import type {
  AuditEvent,
  BatchRecord,
  BatchStatusUpdate,
  DelegatorLineRecord,
  DistributionRecord,
  DistributionSnapshot,
  DistributionStatus,
  InjectionIntent,
  NewDistribution,
  PayoutStore,
  Settlement,
  StoredAuditEvent,
} from './types';

interface DistributionState {
  distribution: DistributionRecord;
  lines: Map<string, DelegatorLineRecord>;
  batches: Map<number, BatchRecord>;
}

function key(bakerId: string, cycle: number): string {
  return `${bakerId}#${cycle}`;
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
  private readonly audit: StoredAuditEvent[] = [];

  /** Test hook: how many times a hash was written. Never used by the engine. */
  readonly injectionIntents: InjectionIntent[] = [];

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
    this.injectionIntents.push(intent);
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

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push({ ...event, id: this.audit.length + 1 });
  }

  async listAudit(bakerId: string, cycle?: number): Promise<StoredAuditEvent[]> {
    return this.audit.filter(
      (event) =>
        event.bakerId === bakerId && (cycle === undefined || event.cycle === cycle),
    );
  }

  /** Test hook: the carry-over ledger as the store holds it. */
  carryOverOf(bakerId: string): Map<string, Mutez> {
    return new Map(this.carryOver.get(bakerId) ?? []);
  }

  /** Test hook: seed balances owed from cycles that predate this store. */
  seedCarryOver(bakerId: string, balances: ReadonlyMap<string, Mutez>): void {
    this.carryOver.set(bakerId, new Map(balances));
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
