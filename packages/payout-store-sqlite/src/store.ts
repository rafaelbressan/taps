import { InvariantViolationError, type Mutez } from '@tezos-suite/chain';
import {
  DuplicateDistributionError,
  DuplicateOperationError,
  DuplicateSettlementError,
  type AuditEvent,
  type BatchRecord,
  type BatchStatusUpdate,
  type DebtSettlementLine,
  type DebtSettlementRecord,
  type DelegatorLineRecord,
  type DistributionRecord,
  type DistributionSnapshot,
  type DistributionStatus,
  type InjectionIntent,
  type NewDebtSettlement,
  type NewDistribution,
  type PayoutStore,
  type PersistedTransfer,
  type Settlement,
  type SettlementIntent,
  type SettlementStatusUpdate,
  type StoredAuditEvent,
} from '@tezos-suite/payout';
import {
  bigintOf,
  bool,
  boolOf,
  dateOf,
  dateOrNull,
  decodeJson,
  encodeJson,
  intOf,
  intOrNull,
  iso,
  isoOrNull,
  mutezOf,
  textOf,
  textOrNull,
} from './codec';
import type { SqlDatabase, SqlRow, SqlTransaction, SqlValue } from './db';

/**
 * `PayoutStore` on SQLite.
 *
 * The version this replaces kept payout state in Postgres with no migration
 * at all, no `@@unique([bakerId, cycle])`, and a `Cascade` that deleted the
 * financial history when a configuration row went away. Here the properties
 * that keep money safe are columns and constraints:
 *
 * - `PRIMARY KEY (baker_id, cycle)` — a second distribution of a cycle is
 *   refused by the database, not by an `if`.
 * - `operation_hashes.op_hash PRIMARY KEY` — one operation belongs to one
 *   place, forever, across cycles and debt settlements alike.
 * - Every write that touches more than one row runs inside one transaction, so
 *   a settlement lands whole or not at all.
 * - `ON DELETE RESTRICT` everywhere. Nothing in this schema deletes history.
 *
 * The in-memory store stays the reference implementation of the same contract;
 * `test/unit/contract.spec.ts` runs the identical suite against both, which is
 * what makes "the constraint is what stops a duplicate payment" checkable
 * rather than asserted.
 */
export class SqlitePayoutStore implements PayoutStore {
  constructor(private readonly db: SqlDatabase) {}

  async getDistribution(
    bakerId: string,
    cycle: number,
  ): Promise<DistributionSnapshot | undefined> {
    return readSnapshot(this.db, bakerId, cycle);
  }

  async getBatch(
    bakerId: string,
    cycle: number,
    index: number,
  ): Promise<BatchRecord | undefined> {
    const rows = await this.db.query(
      'SELECT * FROM batches WHERE baker_id = ? AND cycle = ? AND batch_index = ?',
      [bakerId, cycle, index],
    );
    const row = rows[0];
    if (!row) return undefined;
    return decodeBatch(
      row,
      await readTransfers(this.db, bakerId, cycle, index),
      await readAttempts(this.db, bakerId, cycle, index),
    );
  }

  async createDistribution(input: NewDistribution): Promise<DistributionSnapshot> {
    const { bakerId, cycle } = input.distribution;

    const seenAddresses = new Set<string>();
    for (const line of input.lines) {
      if (seenAddresses.has(line.address)) {
        throw new InvariantViolationError(
          'one delegator line per address per cycle',
          `${bakerId} cycle ${cycle} lists ${line.address} twice`,
        );
      }
      seenAddresses.add(line.address);
    }
    const seenBatches = new Set<number>();
    for (const batch of input.batches) {
      if (seenBatches.has(batch.index)) {
        throw new InvariantViolationError(
          'one record per batch index',
          `${bakerId} cycle ${cycle} lists batch ${batch.index} twice`,
        );
      }
      seenBatches.add(batch.index);
    }

    const now = new Date();
    await this.db.transaction(async (tx) => {
      const existing = await tx.query(
        'SELECT 1 AS present FROM distributions WHERE baker_id = ? AND cycle = ?',
        [bakerId, cycle],
      );
      if (existing.length > 0) throw new DuplicateDistributionError(bakerId, cycle);

      const d = input.distribution;
      await tx.execute(
        `INSERT INTO distributions (
           baker_id, cycle, status, network, protocol_hash,
           pool, own_share, baker_fee, distributable, remainder, total_to_send,
           fee_numerator, fee_denominator, block_fees_included,
           payout_factor_numerator, payout_factor_denominator,
           delegator_count, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          d.bakerId,
          d.cycle,
          'planned',
          d.network,
          d.protocolHash,
          d.pool,
          d.ownShare,
          d.bakerFee,
          d.distributable,
          d.remainder,
          d.totalToSend,
          d.feeNumerator,
          d.feeDenominator,
          bool(d.blockFeesIncluded),
          d.payoutFactorNumerator,
          d.payoutFactorDenominator,
          d.delegatorCount,
          iso(now),
          iso(now),
        ],
      );

      for (const line of input.lines) {
        await tx.execute(
          `INSERT INTO delegator_lines (
             baker_id, cycle, address, delegated_balance,
             gross, commission, net, carried_in, payable,
             transfer_cost, minimum, withheld, amount, carried_out,
             emptied, batch_index, op_hash, result
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'planned')`,
          [
            bakerId,
            cycle,
            line.address,
            line.delegatedBalanceMutez,
            line.grossMutez,
            line.commissionMutez,
            line.netMutez,
            line.carriedInMutez,
            line.payableMutez,
            line.transferCostMutez,
            line.minimumMutez,
            line.withheldMutez,
            line.amountMutez,
            line.carriedOutMutez,
            bool(line.emptied),
          ],
        );
      }

      for (const batch of input.batches) {
        await tx.execute(
          `INSERT INTO batches (
             baker_id, cycle, batch_index, status,
             op_hash, counter, branch, branch_level,
             total_amount, total_fees, total_burn, total_gas, total_storage,
             injected_at, included_level, confirmed_at, error
           ) VALUES (?,?,?,'pending',NULL,NULL,NULL,NULL,?,?,?,?,?,NULL,NULL,NULL,NULL)`,
          [
            bakerId,
            cycle,
            batch.index,
            batch.totalAmount,
            batch.totalFees,
            batch.totalBurn,
            batch.totalGas,
            batch.totalStorage,
          ],
        );
        await insertTransfers(tx, bakerId, cycle, batch.index, batch.transfers);
      }
    });

    const snapshot = await readSnapshot(this.db, bakerId, cycle);
    if (!snapshot) {
      throw new InvariantViolationError(
        'the distribution just written is readable',
        `${bakerId} cycle ${cycle} vanished between the commit and the read`,
      );
    }
    return snapshot;
  }

  async listCycleStatuses(bakerId: string): Promise<Map<number, DistributionStatus>> {
    const rows = await this.db.query(
      'SELECT cycle, status FROM distributions WHERE baker_id = ? ORDER BY cycle',
      [bakerId],
    );
    return new Map(
      rows.map((row) => [intOf(row, 'cycle'), textOf(row, 'status') as DistributionStatus]),
    );
  }

  async loadCarryOver(bakerId: string): Promise<Map<string, Mutez>> {
    const rows = await this.db.query(
      'SELECT address, balance FROM carry_over WHERE baker_id = ? ORDER BY address',
      [bakerId],
    );
    return new Map(rows.map((row) => [textOf(row, 'address'), mutezOf(row, 'balance')]));
  }

  async recordInjectionIntent(intent: InjectionIntent): Promise<void> {
    const self = batchOwner(intent.bakerId, intent.cycle, intent.index);
    await this.db.transaction(async (tx) => {
      const owner = await hashOwner(tx, intent.opHash);
      if (owner !== undefined && owner !== self) {
        throw new DuplicateOperationError(intent.opHash);
      }

      await requireDistribution(tx, intent.bakerId, intent.cycle);
      const rows = await tx.query(
        'SELECT * FROM batches WHERE baker_id = ? AND cycle = ? AND batch_index = ?',
        [intent.bakerId, intent.cycle, intent.index],
      );
      const batch = rows[0];
      if (!batch) {
        throw new InvariantViolationError(
          'the batch being injected was planned',
          `${self} has no planned batch`,
        );
      }

      const previousHash = textOrNull(batch, 'op_hash');
      const status = textOf(batch, 'status');
      // The earlier hash is never dropped: it is the evidence that the money
      // may already have left. A fresh attempt is APPENDED, and only once the
      // chain has said the previous one can never land.
      if (previousHash !== null && previousHash !== intent.opHash) {
        if (status !== 'expired' && status !== 'failed') {
          throw new InvariantViolationError(
            'a new attempt needs the previous one expired or failed',
            `${self} carries ${previousHash} in state "${status}"; ` +
              `recording ${intent.opHash} now could pay the same delegators twice`,
          );
        }
      }

      await tx.execute(
        'INSERT OR REPLACE INTO operation_hashes (op_hash, owner) VALUES (?, ?)',
        [intent.opHash, self],
      );

      if (previousHash !== intent.opHash) {
        const seq = await nextSeq(
          tx,
          'SELECT COUNT(*) AS n FROM batch_attempts WHERE baker_id = ? AND cycle = ? AND batch_index = ?',
          [intent.bakerId, intent.cycle, intent.index],
        );
        await tx.execute(
          `INSERT INTO batch_attempts
             (baker_id, cycle, batch_index, seq, op_hash, counter, branch, branch_level, at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            intent.bakerId,
            intent.cycle,
            intent.index,
            seq,
            intent.opHash,
            intent.counter,
            intent.branch,
            intent.branchLevel,
            iso(intent.at),
          ],
        );
      }

      await tx.execute(
        `UPDATE batches SET status = 'pending', op_hash = ?, counter = ?, branch = ?,
           branch_level = ?, injected_at = ?
         WHERE baker_id = ? AND cycle = ? AND batch_index = ?`,
        [
          intent.opHash,
          intent.counter,
          intent.branch,
          intent.branchLevel,
          iso(intent.at),
          intent.bakerId,
          intent.cycle,
          intent.index,
        ],
      );
      await tx.execute(
        `UPDATE distributions SET status = 'sending', updated_at = ?
         WHERE baker_id = ? AND cycle = ?`,
        [iso(intent.at), intent.bakerId, intent.cycle],
      );
    });
  }

  async recordBatchStatus(update: BatchStatusUpdate): Promise<void> {
    await this.db.transaction(async (tx) => {
      await requireDistribution(tx, update.bakerId, update.cycle);
      const rows = await tx.query(
        'SELECT 1 AS present FROM batches WHERE baker_id = ? AND cycle = ? AND batch_index = ?',
        [update.bakerId, update.cycle, update.index],
      );
      if (rows.length === 0) {
        throw new InvariantViolationError(
          'the batch being updated exists',
          `${batchOwner(update.bakerId, update.cycle, update.index)} was never planned`,
        );
      }
      // `?? existing` semantics: an omitted field leaves what is there. Doing
      // it in SQL with COALESCE keeps the read and the write in one statement.
      await tx.execute(
        `UPDATE batches SET
           status = ?,
           included_level = COALESCE(?, included_level),
           confirmed_at = COALESCE(?, confirmed_at),
           error = COALESCE(?, error)
         WHERE baker_id = ? AND cycle = ? AND batch_index = ?`,
        [
          update.status,
          update.includedLevel ?? null,
          isoOrNull(update.confirmedAt ?? null),
          update.error ?? null,
          update.bakerId,
          update.cycle,
          update.index,
        ],
      );
      await tx.execute(
        'UPDATE distributions SET updated_at = ? WHERE baker_id = ? AND cycle = ?',
        [iso(new Date()), update.bakerId, update.cycle],
      );
    });
  }

  async setDistributionStatus(
    bakerId: string,
    cycle: number,
    status: DistributionStatus,
    at: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await requireDistribution(tx, bakerId, cycle);
      await tx.execute(
        'UPDATE distributions SET status = ?, updated_at = ? WHERE baker_id = ? AND cycle = ?',
        [status, iso(at), bakerId, cycle],
      );
    });
  }

  async settleDistribution(settlement: Settlement): Promise<void> {
    await this.db.transaction(async (tx) => {
      await requireDistribution(tx, settlement.bakerId, settlement.cycle);

      for (const line of settlement.lines) {
        const rows = await tx.query(
          'SELECT 1 AS present FROM delegator_lines WHERE baker_id = ? AND cycle = ? AND address = ?',
          [settlement.bakerId, settlement.cycle, line.address],
        );
        if (rows.length === 0) {
          throw new InvariantViolationError(
            'settling a delegator that was planned',
            `${settlement.bakerId} cycle ${settlement.cycle} has no line for ${line.address}`,
          );
        }
        await tx.execute(
          `UPDATE delegator_lines SET result = ?, batch_index = ?, op_hash = ?
           WHERE baker_id = ? AND cycle = ? AND address = ?`,
          [
            line.result,
            line.batchIndex,
            line.opHash,
            settlement.bakerId,
            settlement.cycle,
            line.address,
          ],
        );
      }

      for (const [address, balance] of settlement.carryOver) {
        if (balance < 0n) {
          throw new InvariantViolationError(
            'carry-over balance >= 0',
            `${address} would carry ${balance} mutez`,
          );
        }
        if (balance === 0n) {
          await tx.execute('DELETE FROM carry_over WHERE baker_id = ? AND address = ?', [
            settlement.bakerId,
            address,
          ]);
        } else {
          await tx.execute(
            'INSERT OR REPLACE INTO carry_over (baker_id, address, balance) VALUES (?,?,?)',
            [settlement.bakerId, address, balance],
          );
        }
      }

      await tx.execute(
        'UPDATE distributions SET status = ?, updated_at = ? WHERE baker_id = ? AND cycle = ?',
        [settlement.status, iso(settlement.at), settlement.bakerId, settlement.cycle],
      );
    });
  }

  async createDebtSettlement(input: NewDebtSettlement): Promise<DebtSettlementRecord> {
    if (input.lines.length === 0) {
      throw new InvariantViolationError(
        'a debt settlement pays at least one address',
        `${input.bakerId} asked for ${input.settlementId} with no lines`,
      );
    }

    const now = new Date();
    await this.db.transaction(async (tx) => {
      const existing = await tx.query(
        'SELECT 1 AS present FROM debt_settlements WHERE baker_id = ? AND settlement_id = ?',
        [input.bakerId, input.settlementId],
      );
      if (existing.length > 0) {
        throw new DuplicateSettlementError(input.bakerId, input.settlementId);
      }
      await tx.execute(
        `INSERT INTO debt_settlements (
           baker_id, settlement_id, status, network, protocol_hash, actor, reason,
           total_amount, total_fees, total_burn,
           op_hash, counter, branch, branch_level,
           injected_at, included_level, confirmed_at, error,
           created_at, updated_at
         ) VALUES (?,?,'planned',?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?)`,
        [
          input.bakerId,
          input.settlementId,
          input.network,
          input.protocolHash,
          input.actor,
          input.reason,
          input.totalAmount,
          input.totalFees,
          input.totalBurn,
          iso(now),
          iso(now),
        ],
      );
      let position = 0;
      for (const line of input.lines) {
        await tx.execute(
          `INSERT INTO debt_settlement_lines
             (baker_id, settlement_id, position, address, amount, fee, gas_limit, storage_limit, burn)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            input.bakerId,
            input.settlementId,
            position,
            line.address,
            line.amountMutez,
            line.feeMutez,
            line.gasLimit,
            line.storageLimit,
            line.burnMutez,
          ],
        );
        position += 1;
      }
    });

    const record = await this.getDebtSettlement(input.bakerId, input.settlementId);
    if (!record) {
      throw new InvariantViolationError(
        'the settlement just written is readable',
        `${input.bakerId}/${input.settlementId} vanished between the commit and the read`,
      );
    }
    return record;
  }

  async getDebtSettlement(
    bakerId: string,
    settlementId: string,
  ): Promise<DebtSettlementRecord | undefined> {
    const rows = await this.db.query(
      'SELECT * FROM debt_settlements WHERE baker_id = ? AND settlement_id = ?',
      [bakerId, settlementId],
    );
    const row = rows[0];
    if (!row) return undefined;

    const lines = (
      await this.db.query(
        `SELECT * FROM debt_settlement_lines
         WHERE baker_id = ? AND settlement_id = ? ORDER BY position`,
        [bakerId, settlementId],
      )
    ).map(decodeSettlementLine);

    const attempts = (
      await this.db.query(
        `SELECT * FROM settlement_attempts
         WHERE baker_id = ? AND settlement_id = ? ORDER BY seq`,
        [bakerId, settlementId],
      )
    ).map(
      (attempt): SettlementIntent => ({
        bakerId: textOf(attempt, 'baker_id'),
        settlementId: textOf(attempt, 'settlement_id'),
        opHash: textOf(attempt, 'op_hash'),
        counter: textOf(attempt, 'counter'),
        branch: textOf(attempt, 'branch'),
        branchLevel: intOf(attempt, 'branch_level'),
        at: dateOf(attempt, 'at'),
      }),
    );

    return {
      bakerId: textOf(row, 'baker_id'),
      settlementId: textOf(row, 'settlement_id'),
      status: textOf(row, 'status') as DebtSettlementRecord['status'],
      network: textOf(row, 'network'),
      protocolHash: textOf(row, 'protocol_hash'),
      actor: textOf(row, 'actor'),
      reason: textOf(row, 'reason'),
      lines,
      totalAmount: mutezOf(row, 'total_amount'),
      totalFees: mutezOf(row, 'total_fees'),
      totalBurn: mutezOf(row, 'total_burn'),
      opHash: textOrNull(row, 'op_hash'),
      counter: textOrNull(row, 'counter'),
      branch: textOrNull(row, 'branch'),
      branchLevel: intOrNull(row, 'branch_level'),
      attempts,
      injectedAt: dateOrNull(row, 'injected_at'),
      includedLevel: intOrNull(row, 'included_level'),
      confirmedAt: dateOrNull(row, 'confirmed_at'),
      error: textOrNull(row, 'error'),
      createdAt: dateOf(row, 'created_at'),
      updatedAt: dateOf(row, 'updated_at'),
    };
  }

  async listOpenSettlements(bakerId: string): Promise<readonly string[]> {
    const rows = await this.db.query(
      `SELECT settlement_id FROM debt_settlements
       WHERE baker_id = ? AND status IN ('planned','sending')
       ORDER BY settlement_id`,
      [bakerId],
    );
    return rows.map((row) => textOf(row, 'settlement_id'));
  }

  async recordSettlementIntent(intent: SettlementIntent): Promise<void> {
    const self = settlementOwner(intent.bakerId, intent.settlementId);
    await this.db.transaction(async (tx) => {
      const owner = await hashOwner(tx, intent.opHash);
      if (owner !== undefined && owner !== self) {
        throw new DuplicateOperationError(intent.opHash);
      }

      const rows = await tx.query(
        'SELECT status, op_hash FROM debt_settlements WHERE baker_id = ? AND settlement_id = ?',
        [intent.bakerId, intent.settlementId],
      );
      const record = rows[0];
      if (!record) {
        throw new InvariantViolationError(
          'the settlement being written was created',
          `${intent.bakerId} has no debt settlement called ${intent.settlementId}`,
        );
      }

      const previousHash = textOrNull(record, 'op_hash');
      const status = textOf(record, 'status');
      if (previousHash !== null && previousHash !== intent.opHash && status !== 'failed') {
        throw new InvariantViolationError(
          'a new settlement attempt needs the previous one failed',
          `${self} carries ${previousHash} in state "${status}"; ` +
            `recording ${intent.opHash} now could pay the same debt twice`,
        );
      }

      await tx.execute(
        'INSERT OR REPLACE INTO operation_hashes (op_hash, owner) VALUES (?, ?)',
        [intent.opHash, self],
      );

      if (previousHash !== intent.opHash) {
        const seq = await nextSeq(
          tx,
          'SELECT COUNT(*) AS n FROM settlement_attempts WHERE baker_id = ? AND settlement_id = ?',
          [intent.bakerId, intent.settlementId],
        );
        await tx.execute(
          `INSERT INTO settlement_attempts
             (baker_id, settlement_id, seq, op_hash, counter, branch, branch_level, at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            intent.bakerId,
            intent.settlementId,
            seq,
            intent.opHash,
            intent.counter,
            intent.branch,
            intent.branchLevel,
            iso(intent.at),
          ],
        );
      }

      await tx.execute(
        `UPDATE debt_settlements SET status = 'sending', op_hash = ?, counter = ?,
           branch = ?, branch_level = ?, injected_at = ?, updated_at = ?
         WHERE baker_id = ? AND settlement_id = ?`,
        [
          intent.opHash,
          intent.counter,
          intent.branch,
          intent.branchLevel,
          iso(intent.at),
          iso(intent.at),
          intent.bakerId,
          intent.settlementId,
        ],
      );
    });
  }

  async recordSettlementStatus(update: SettlementStatusUpdate): Promise<void> {
    if (update.cleared && update.cleared.length > 0 && update.status !== 'settled') {
      throw new InvariantViolationError(
        'a debt is only cleared by a settled settlement',
        `${update.settlementId} tried to clear ${update.cleared.length} debt(s) while ` +
          `"${update.status}" — an unconfirmed clear is a debt silently forgiven`,
      );
    }

    await this.db.transaction(async (tx) => {
      const rows = await tx.query(
        'SELECT 1 AS present FROM debt_settlements WHERE baker_id = ? AND settlement_id = ?',
        [update.bakerId, update.settlementId],
      );
      if (rows.length === 0) {
        throw new InvariantViolationError(
          'the settlement being written was created',
          `${update.bakerId} has no debt settlement called ${update.settlementId}`,
        );
      }

      for (const address of update.cleared ?? []) {
        const owedRows = await tx.query(
          'SELECT balance FROM carry_over WHERE baker_id = ? AND address = ?',
          [update.bakerId, address],
        );
        const owedRow = owedRows[0];
        if (!owedRow) {
          throw new InvariantViolationError(
            'clearing a debt that is on record',
            `${update.bakerId} carries no debt for ${address}`,
          );
        }
        const owed = mutezOf(owedRow, 'balance');
        const lineRows = await tx.query(
          `SELECT amount FROM debt_settlement_lines
           WHERE baker_id = ? AND settlement_id = ? AND address = ?`,
          [update.bakerId, update.settlementId, address],
        );
        const lineRow = lineRows[0];
        const paid = lineRow ? mutezOf(lineRow, 'amount') : null;
        if (paid === null || paid !== owed) {
          throw new InvariantViolationError(
            'the settled amount is exactly the debt on record',
            `${address}: settlement paid ${paid ?? 'nothing'}, store carries ${owed}`,
          );
        }
        await tx.execute('DELETE FROM carry_over WHERE baker_id = ? AND address = ?', [
          update.bakerId,
          address,
        ]);
      }

      await tx.execute(
        `UPDATE debt_settlements SET
           status = ?,
           included_level = COALESCE(?, included_level),
           confirmed_at = COALESCE(?, confirmed_at),
           error = COALESCE(?, error),
           updated_at = ?
         WHERE baker_id = ? AND settlement_id = ?`,
        [
          update.status,
          update.includedLevel ?? null,
          isoOrNull(update.confirmedAt ?? null),
          update.error ?? null,
          iso(update.at),
          update.bakerId,
          update.settlementId,
        ],
      );
    });
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.db.execute(
      `INSERT INTO audit
         (at, baker_id, cycle, actor, source, action, outcome, params, op_hash, destinations, amount, detail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        iso(event.at),
        event.bakerId,
        event.cycle,
        event.actor,
        event.source,
        event.action,
        event.outcome,
        encodeJson(event.params),
        event.opHash ?? null,
        event.destinations ? encodeJson(event.destinations) : null,
        event.amountMutez ?? null,
        event.detail ?? null,
      ],
    );
  }

  async listAudit(bakerId: string, cycle?: number): Promise<StoredAuditEvent[]> {
    const rows =
      cycle === undefined
        ? await this.db.query('SELECT * FROM audit WHERE baker_id = ? ORDER BY id', [
            bakerId,
          ])
        : await this.db.query(
            'SELECT * FROM audit WHERE baker_id = ? AND cycle = ? ORDER BY id',
            [bakerId, cycle],
          );

    return rows.map((row) => {
      const destinations = textOrNull(row, 'destinations');
      const amount = row.amount;
      return {
        id: intOf(row, 'id'),
        at: dateOf(row, 'at'),
        bakerId: textOf(row, 'baker_id'),
        cycle: intOrNull(row, 'cycle'),
        actor: textOf(row, 'actor'),
        source: textOf(row, 'source'),
        action: textOf(row, 'action'),
        outcome: textOf(row, 'outcome') as StoredAuditEvent['outcome'],
        params: decodeJson<Record<string, unknown>>(textOf(row, 'params')),
        opHash: textOrNull(row, 'op_hash'),
        ...(destinations === null
          ? {}
          : { destinations: decodeJson<string[]>(destinations) }),
        amountMutez: amount === null || amount === undefined ? null : bigintOf(row, 'amount'),
        ...(textOrNull(row, 'detail') === null
          ? {}
          : { detail: textOf(row, 'detail') }),
      };
    });
  }
}

function batchOwner(bakerId: string, cycle: number, index: number): string {
  // Same string the in-memory store uses, so a database and a JSON file can be
  // compared row for row when a defect has to be reproduced in both.
  return `${bakerId}#${cycle}/${index}`;
}

function settlementOwner(bakerId: string, settlementId: string): string {
  return `${bakerId}#settlement:${settlementId}`;
}

async function hashOwner(tx: SqlTransaction, opHash: string): Promise<string | undefined> {
  const rows = await tx.query('SELECT owner FROM operation_hashes WHERE op_hash = ?', [
    opHash,
  ]);
  const row = rows[0];
  return row ? textOf(row, 'owner') : undefined;
}

async function requireDistribution(
  tx: SqlTransaction,
  bakerId: string,
  cycle: number,
): Promise<void> {
  const rows = await tx.query(
    'SELECT 1 AS present FROM distributions WHERE baker_id = ? AND cycle = ?',
    [bakerId, cycle],
  );
  if (rows.length === 0) {
    throw new InvariantViolationError(
      'the distribution being written was created',
      `${bakerId} has no distribution for cycle ${cycle}`,
    );
  }
}

async function nextSeq(
  tx: SqlTransaction,
  sql: string,
  params: readonly SqlValue[],
): Promise<number> {
  const rows = await tx.query(sql, params);
  const row = rows[0];
  return row ? intOf(row, 'n') : 0;
}

async function insertTransfers(
  tx: SqlTransaction,
  bakerId: string,
  cycle: number,
  index: number,
  transfers: readonly PersistedTransfer[],
): Promise<void> {
  let position = 0;
  for (const transfer of transfers) {
    await tx.execute(
      `INSERT INTO batch_transfers
         (baker_id, cycle, batch_index, position, address, amount, fee, gas_limit, storage_limit, burn)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        bakerId,
        cycle,
        index,
        position,
        transfer.address,
        transfer.amountMutez,
        transfer.feeMutez,
        transfer.gasLimit,
        transfer.storageLimit,
        transfer.burnMutez,
      ],
    );
    position += 1;
  }
}

async function readTransfers(
  db: SqlDatabase,
  bakerId: string,
  cycle: number,
  index: number,
): Promise<PersistedTransfer[]> {
  const rows = await db.query(
    `SELECT * FROM batch_transfers
     WHERE baker_id = ? AND cycle = ? AND batch_index = ? ORDER BY position`,
    [bakerId, cycle, index],
  );
  return rows.map((row) => ({
    address: textOf(row, 'address'),
    amountMutez: mutezOf(row, 'amount'),
    feeMutez: mutezOf(row, 'fee'),
    gasLimit: bigintOf(row, 'gas_limit'),
    storageLimit: bigintOf(row, 'storage_limit'),
    burnMutez: mutezOf(row, 'burn'),
  }));
}

async function readAttempts(
  db: SqlDatabase,
  bakerId: string,
  cycle: number,
  index: number,
): Promise<InjectionIntent[]> {
  const rows = await db.query(
    `SELECT * FROM batch_attempts
     WHERE baker_id = ? AND cycle = ? AND batch_index = ? ORDER BY seq`,
    [bakerId, cycle, index],
  );
  return rows.map((row) => ({
    bakerId: textOf(row, 'baker_id'),
    cycle: intOf(row, 'cycle'),
    index: intOf(row, 'batch_index'),
    opHash: textOf(row, 'op_hash'),
    counter: textOf(row, 'counter'),
    branch: textOf(row, 'branch'),
    branchLevel: intOf(row, 'branch_level'),
    at: dateOf(row, 'at'),
  }));
}

async function readSnapshot(
  db: SqlDatabase,
  bakerId: string,
  cycle: number,
): Promise<DistributionSnapshot | undefined> {
  const rows = await db.query(
    'SELECT * FROM distributions WHERE baker_id = ? AND cycle = ?',
    [bakerId, cycle],
  );
  const row = rows[0];
  if (!row) return undefined;

  const distribution: DistributionRecord = {
    bakerId: textOf(row, 'baker_id'),
    cycle: intOf(row, 'cycle'),
    status: textOf(row, 'status') as DistributionStatus,
    network: textOf(row, 'network'),
    protocolHash: textOf(row, 'protocol_hash'),
    pool: mutezOf(row, 'pool'),
    ownShare: mutezOf(row, 'own_share'),
    bakerFee: mutezOf(row, 'baker_fee'),
    distributable: mutezOf(row, 'distributable'),
    remainder: mutezOf(row, 'remainder'),
    totalToSend: mutezOf(row, 'total_to_send'),
    feeNumerator: bigintOf(row, 'fee_numerator'),
    feeDenominator: bigintOf(row, 'fee_denominator'),
    blockFeesIncluded: boolOf(row, 'block_fees_included'),
    payoutFactorNumerator: bigintOf(row, 'payout_factor_numerator'),
    payoutFactorDenominator: bigintOf(row, 'payout_factor_denominator'),
    delegatorCount: intOf(row, 'delegator_count'),
    createdAt: dateOf(row, 'created_at'),
    updatedAt: dateOf(row, 'updated_at'),
  };

  const lines = (
    await db.query(
      'SELECT * FROM delegator_lines WHERE baker_id = ? AND cycle = ? ORDER BY rowid',
      [bakerId, cycle],
    )
  ).map(decodeLine);

  const batchRows = await db.query(
    'SELECT * FROM batches WHERE baker_id = ? AND cycle = ? ORDER BY batch_index',
    [bakerId, cycle],
  );
  const batches: BatchRecord[] = [];
  for (const batchRow of batchRows) {
    const index = intOf(batchRow, 'batch_index');
    batches.push(
      decodeBatch(
        batchRow,
        await readTransfers(db, bakerId, cycle, index),
        await readAttempts(db, bakerId, cycle, index),
      ),
    );
  }

  return { distribution, lines, batches };
}

function decodeLine(row: SqlRow): DelegatorLineRecord {
  return {
    bakerId: textOf(row, 'baker_id'),
    cycle: intOf(row, 'cycle'),
    address: textOf(row, 'address'),
    delegatedBalanceMutez: mutezOf(row, 'delegated_balance'),
    grossMutez: mutezOf(row, 'gross'),
    commissionMutez: mutezOf(row, 'commission'),
    netMutez: mutezOf(row, 'net'),
    carriedInMutez: mutezOf(row, 'carried_in'),
    payableMutez: mutezOf(row, 'payable'),
    transferCostMutez: mutezOf(row, 'transfer_cost'),
    minimumMutez: mutezOf(row, 'minimum'),
    withheldMutez: mutezOf(row, 'withheld'),
    amountMutez: mutezOf(row, 'amount'),
    carriedOutMutez: mutezOf(row, 'carried_out'),
    emptied: boolOf(row, 'emptied'),
    batchIndex: intOrNull(row, 'batch_index'),
    opHash: textOrNull(row, 'op_hash'),
    result: textOf(row, 'result') as DelegatorLineRecord['result'],
  };
}

function decodeBatch(
  row: SqlRow,
  transfers: readonly PersistedTransfer[],
  attempts: readonly InjectionIntent[],
): BatchRecord {
  return {
    bakerId: textOf(row, 'baker_id'),
    cycle: intOf(row, 'cycle'),
    index: intOf(row, 'batch_index'),
    status: textOf(row, 'status') as BatchRecord['status'],
    opHash: textOrNull(row, 'op_hash'),
    counter: textOrNull(row, 'counter'),
    branch: textOrNull(row, 'branch'),
    branchLevel: intOrNull(row, 'branch_level'),
    attempts,
    transfers,
    totalAmount: mutezOf(row, 'total_amount'),
    totalFees: mutezOf(row, 'total_fees'),
    totalBurn: mutezOf(row, 'total_burn'),
    totalGas: bigintOf(row, 'total_gas'),
    totalStorage: bigintOf(row, 'total_storage'),
    injectedAt: dateOrNull(row, 'injected_at'),
    includedLevel: intOrNull(row, 'included_level'),
    confirmedAt: dateOrNull(row, 'confirmed_at'),
    error: textOrNull(row, 'error'),
  };
}

function decodeSettlementLine(row: SqlRow): DebtSettlementLine {
  return {
    address: textOf(row, 'address'),
    amountMutez: mutezOf(row, 'amount'),
    feeMutez: mutezOf(row, 'fee'),
    gasLimit: bigintOf(row, 'gas_limit'),
    storageLimit: bigintOf(row, 'storage_limit'),
    burnMutez: mutezOf(row, 'burn'),
  };
}
