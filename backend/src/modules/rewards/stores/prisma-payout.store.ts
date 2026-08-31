import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DuplicateDistributionError,
  DuplicateOperationError,
  type AuditEvent,
  type BatchRecord,
  type BatchStatusUpdate,
  type DelegatorLineRecord,
  type DistributionSnapshot,
  type DistributionStatus,
  type InjectionIntent,
  type NewDistribution,
  type PayoutStore,
  type Settlement,
  type StoredAuditEvent,
} from '@tezos-suite/payout';
import { InvariantViolationError } from '@tezos-suite/chain';
import { PrismaService } from '../../../database/prisma.service';

/**
 * `PayoutStore` on Postgres.
 *
 * The engine's safety does not rest on this file: it rests on the constraints
 * in `schema.prisma` — one distribution per `(baker_id, cycle)`, one row per
 * operation hash, an attempts table nothing deletes from. What this adapter
 * has to get right is that every multi-row write happens inside ONE
 * transaction, so a crash cannot leave a distribution half-settled.
 */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION
  );
}

@Injectable()
export class PrismaPayoutStore implements PayoutStore {
  constructor(private readonly prisma: PrismaService) {}

  async getDistribution(
    bakerId: string,
    cycle: number,
  ): Promise<DistributionSnapshot | undefined> {
    const row = await this.prisma.payoutDistribution.findUnique({
      where: { bakerId_cycle: { bakerId, cycle } },
      include: {
        lines: true,
        batches: { include: { transfers: true, attempts: true }, orderBy: { index: 'asc' } },
      },
    });
    if (!row) return undefined;

    return {
      distribution: {
        bakerId: row.bakerId,
        cycle: row.cycle,
        status: row.status as DistributionStatus,
        network: row.network,
        protocolHash: row.protocolHash,
        pool: row.poolMutez,
        ownShare: row.ownShareMutez,
        bakerFee: row.bakerFeeMutez,
        distributable: row.distributableMutez,
        remainder: row.remainderMutez,
        totalToSend: row.totalToSendMutez,
        feeNumerator: row.feeNumerator,
        feeDenominator: row.feeDenominator,
        blockFeesIncluded: row.blockFeesIncluded,
        delegatorCount: row.delegatorCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      lines: row.lines.map((line): DelegatorLineRecord => ({
        bakerId,
        cycle,
        address: line.address,
        delegatedBalanceMutez: line.delegatedBalanceMutez,
        grossMutez: line.grossMutez,
        commissionMutez: line.commissionMutez,
        netMutez: line.netMutez,
        carriedInMutez: line.carriedInMutez,
        payableMutez: line.payableMutez,
        minimumMutez: line.minimumMutez,
        withheldMutez: line.withheldMutez,
        amountMutez: line.amountMutez,
        carriedOutMutez: line.carriedOutMutez,
        emptied: line.emptied,
        batchIndex: line.batchIndex,
        opHash: line.opHash,
        result: line.result as DelegatorLineRecord['result'],
      })),
      batches: row.batches.map((batch) => toBatchRecord(bakerId, cycle, batch)),
    };
  }

  async getBatch(
    bakerId: string,
    cycle: number,
    index: number,
  ): Promise<BatchRecord | undefined> {
    const distribution = await this.prisma.payoutDistribution.findUnique({
      where: { bakerId_cycle: { bakerId, cycle } },
      select: { id: true },
    });
    if (!distribution) return undefined;

    const batch = await this.prisma.payoutBatch.findUnique({
      where: { distributionId_index: { distributionId: distribution.id, index } },
      include: { transfers: true, attempts: true },
    });
    return batch ? toBatchRecord(bakerId, cycle, batch) : undefined;
  }

  async createDistribution(input: NewDistribution): Promise<DistributionSnapshot> {
    const { bakerId, cycle } = input.distribution;
    try {
      await this.prisma.$transaction(async (tx) => {
        const distribution = await tx.payoutDistribution.create({
          data: {
            bakerId,
            cycle,
            status: 'planned',
            network: input.distribution.network,
            protocolHash: input.distribution.protocolHash,
            poolMutez: input.distribution.pool,
            ownShareMutez: input.distribution.ownShare,
            bakerFeeMutez: input.distribution.bakerFee,
            distributableMutez: input.distribution.distributable,
            remainderMutez: input.distribution.remainder,
            totalToSendMutez: input.distribution.totalToSend,
            feeNumerator: input.distribution.feeNumerator,
            feeDenominator: input.distribution.feeDenominator,
            blockFeesIncluded: input.distribution.blockFeesIncluded,
            delegatorCount: input.distribution.delegatorCount,
          },
        });

        await tx.payoutDelegatorLine.createMany({
          data: input.lines.map((line) => ({
            distributionId: distribution.id,
            address: line.address,
            delegatedBalanceMutez: line.delegatedBalanceMutez,
            grossMutez: line.grossMutez,
            commissionMutez: line.commissionMutez,
            netMutez: line.netMutez,
            carriedInMutez: line.carriedInMutez,
            payableMutez: line.payableMutez,
            minimumMutez: line.minimumMutez,
            withheldMutez: line.withheldMutez,
            amountMutez: line.amountMutez,
            carriedOutMutez: line.carriedOutMutez,
            emptied: line.emptied,
            result: 'planned' as const,
          })),
        });

        for (const batch of input.batches) {
          await tx.payoutBatch.create({
            data: {
              distributionId: distribution.id,
              index: batch.index,
              status: 'pending',
              totalAmountMutez: batch.totalAmount,
              totalFeesMutez: batch.totalFees,
              totalBurnMutez: batch.totalBurn,
              totalGas: batch.totalGas,
              totalStorage: batch.totalStorage,
              transfers: {
                createMany: {
                  data: batch.transfers.map((transfer) => ({
                    address: transfer.address,
                    amountMutez: transfer.amountMutez,
                    feeMutez: transfer.feeMutez,
                    gasLimit: transfer.gasLimit,
                    storageLimit: transfer.storageLimit,
                    burnMutez: transfer.burnMutez,
                  })),
                },
              },
            },
          });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateDistributionError(bakerId, cycle);
      throw error;
    }

    const snapshot = await this.getDistribution(bakerId, cycle);
    if (!snapshot) {
      throw new InvariantViolationError(
        'the distribution just created can be read back',
        `${bakerId} cycle ${cycle}`,
      );
    }
    return snapshot;
  }

  async loadCarryOver(bakerId: string): Promise<Map<string, bigint>> {
    const rows = await this.prisma.payoutCarryOver.findMany({ where: { bakerId } });
    return new Map(rows.map((row) => [row.address, row.balanceMutez]));
  }

  /**
   * The write that has to be durable before the operation reaches the node.
   *
   * The attempt is APPENDED. A new hash for a batch is only accepted once the
   * chain has put that batch in `expired` or `failed`; anything else and the
   * previous operation may still land, so a second one pays twice.
   */
  async recordInjectionIntent(intent: InjectionIntent): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const distribution = await tx.payoutDistribution.findUnique({
          where: { bakerId_cycle: { bakerId: intent.bakerId, cycle: intent.cycle } },
          select: { id: true },
        });
        if (!distribution) {
          throw new InvariantViolationError(
            'the distribution being written was created',
            `${intent.bakerId} has no distribution for cycle ${intent.cycle}`,
          );
        }

        const batch = await tx.payoutBatch.findUnique({
          where: { distributionId_index: { distributionId: distribution.id, index: intent.index } },
        });
        if (!batch) {
          throw new InvariantViolationError(
            'the batch being injected was planned',
            `${intent.bakerId} cycle ${intent.cycle} batch ${intent.index}`,
          );
        }
        if (
          batch.opHash !== null &&
          batch.opHash !== intent.opHash &&
          batch.status !== 'expired' &&
          batch.status !== 'failed'
        ) {
          throw new InvariantViolationError(
            'a new attempt needs the previous one expired or failed',
            `batch ${intent.index} carries ${batch.opHash} in state "${batch.status}"; ` +
              `recording ${intent.opHash} now could pay the same delegators twice`,
          );
        }

        if (batch.opHash !== intent.opHash) {
          await tx.payoutBatchAttempt.create({
            data: {
              batchId: batch.id,
              opHash: intent.opHash,
              counter: intent.counter,
              branch: intent.branch,
              branchLevel: intent.branchLevel,
              at: intent.at,
            },
          });
        }

        await tx.payoutBatch.update({
          where: { id: batch.id },
          data: {
            status: 'pending',
            opHash: intent.opHash,
            counter: intent.counter,
            branch: intent.branch,
            branchLevel: intent.branchLevel,
            injectedAt: intent.at,
          },
        });

        await tx.payoutDistribution.update({
          where: { id: distribution.id },
          data: { status: 'sending' },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateOperationError(intent.opHash);
      throw error;
    }
  }

  async recordBatchStatus(update: BatchStatusUpdate): Promise<void> {
    const distribution = await this.prisma.payoutDistribution.findUnique({
      where: { bakerId_cycle: { bakerId: update.bakerId, cycle: update.cycle } },
      select: { id: true },
    });
    if (!distribution) {
      throw new InvariantViolationError(
        'the batch being updated exists',
        `${update.bakerId} cycle ${update.cycle} batch ${update.index}`,
      );
    }
    await this.prisma.payoutBatch.update({
      where: { distributionId_index: { distributionId: distribution.id, index: update.index } },
      data: {
        status: update.status,
        ...(update.includedLevel === undefined ? {} : { includedLevel: update.includedLevel }),
        ...(update.confirmedAt === undefined ? {} : { confirmedAt: update.confirmedAt }),
        ...(update.error === undefined ? {} : { error: update.error }),
      },
    });
  }

  async setDistributionStatus(
    bakerId: string,
    cycle: number,
    status: DistributionStatus,
    _at: Date,
  ): Promise<void> {
    await this.prisma.payoutDistribution.update({
      where: { bakerId_cycle: { bakerId, cycle } },
      data: { status },
    });
  }

  /** Line results, distribution status and carry-over, or none of them. */
  async settleDistribution(settlement: Settlement): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const distribution = await tx.payoutDistribution.findUnique({
        where: { bakerId_cycle: { bakerId: settlement.bakerId, cycle: settlement.cycle } },
        select: { id: true },
      });
      if (!distribution) {
        throw new InvariantViolationError(
          'the distribution being settled was created',
          `${settlement.bakerId} cycle ${settlement.cycle}`,
        );
      }

      for (const line of settlement.lines) {
        const updated = await tx.payoutDelegatorLine.updateMany({
          where: { distributionId: distribution.id, address: line.address },
          data: { result: line.result, batchIndex: line.batchIndex, opHash: line.opHash },
        });
        if (updated.count !== 1) {
          throw new InvariantViolationError(
            'settling a delegator that was planned',
            `${settlement.bakerId} cycle ${settlement.cycle} has no line for ${line.address}`,
          );
        }
      }

      for (const [address, balance] of settlement.carryOver) {
        if (balance < 0n) {
          throw new InvariantViolationError(
            'carry-over balance >= 0',
            `${address} would carry ${balance} mutez`,
          );
        }
        if (balance === 0n) {
          await tx.payoutCarryOver.deleteMany({
            where: { bakerId: settlement.bakerId, address },
          });
        } else {
          await tx.payoutCarryOver.upsert({
            where: { bakerId_address: { bakerId: settlement.bakerId, address } },
            create: { bakerId: settlement.bakerId, address, balanceMutez: balance },
            update: { balanceMutez: balance },
          });
        }
      }

      await tx.payoutDistribution.update({
        where: { id: distribution.id },
        data: { status: settlement.status },
      });
    });
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.prisma.payoutAuditEvent.create({
      data: {
        at: event.at,
        bakerId: event.bakerId,
        cycle: event.cycle,
        actor: event.actor,
        source: event.source,
        action: event.action,
        outcome: event.outcome,
        params: event.params as Prisma.InputJsonValue,
        opHash: event.opHash ?? null,
        amountMutez: event.amountMutez ?? null,
        detail: event.detail ?? null,
      },
    });
  }

  async listAudit(bakerId: string, cycle?: number): Promise<StoredAuditEvent[]> {
    const rows = await this.prisma.payoutAuditEvent.findMany({
      where: { bakerId, ...(cycle === undefined ? {} : { cycle }) },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      bakerId: row.bakerId,
      cycle: row.cycle,
      actor: row.actor,
      source: row.source,
      action: row.action,
      outcome: row.outcome as StoredAuditEvent['outcome'],
      params: (row.params ?? {}) as Record<string, unknown>,
      opHash: row.opHash,
      amountMutez: row.amountMutez,
      detail: row.detail ?? undefined,
    }));
  }
}

type BatchRow = {
  index: number;
  status: string;
  opHash: string | null;
  counter: string | null;
  branch: string | null;
  branchLevel: number | null;
  totalAmountMutez: bigint;
  totalFeesMutez: bigint;
  totalBurnMutez: bigint;
  totalGas: bigint;
  totalStorage: bigint;
  injectedAt: Date | null;
  includedLevel: number | null;
  confirmedAt: Date | null;
  error: string | null;
  transfers: {
    address: string;
    amountMutez: bigint;
    feeMutez: bigint;
    gasLimit: bigint;
    storageLimit: bigint;
    burnMutez: bigint;
  }[];
  attempts: {
    opHash: string;
    counter: string;
    branch: string;
    branchLevel: number;
    at: Date;
  }[];
};

function toBatchRecord(bakerId: string, cycle: number, batch: BatchRow): BatchRecord {
  return {
    bakerId,
    cycle,
    index: batch.index,
    status: batch.status as BatchRecord['status'],
    opHash: batch.opHash,
    counter: batch.counter,
    branch: batch.branch,
    branchLevel: batch.branchLevel,
    attempts: batch.attempts.map((attempt) => ({
      bakerId,
      cycle,
      index: batch.index,
      opHash: attempt.opHash,
      counter: attempt.counter,
      branch: attempt.branch,
      branchLevel: attempt.branchLevel,
      at: attempt.at,
    })),
    transfers: batch.transfers.map((transfer) => ({
      address: transfer.address,
      amountMutez: transfer.amountMutez,
      feeMutez: transfer.feeMutez,
      gasLimit: transfer.gasLimit,
      storageLimit: transfer.storageLimit,
      burnMutez: transfer.burnMutez,
    })),
    totalAmount: batch.totalAmountMutez,
    totalFees: batch.totalFeesMutez,
    totalBurn: batch.totalBurnMutez,
    totalGas: batch.totalGas,
    totalStorage: batch.totalStorage,
    injectedAt: batch.injectedAt,
    includedLevel: batch.includedLevel,
    confirmedAt: batch.confirmedAt,
    error: batch.error,
  };
}
