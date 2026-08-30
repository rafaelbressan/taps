import { InvariantViolationError } from '../errors';
import type { Mutez } from '../mutez';
import { sumMutez } from '../mutez';
import type { ProtocolConstants } from '../rpc/protocol-constants';
import type { EstimatedTransfer } from './estimate';

/**
 * Batch sizing.
 *
 * `hard_gas_limit_per_block == hard_gas_limit_per_operation == 1 040 000` on
 * mainnet today, but the ceiling that binds a batch is the BLOCK one, against
 * the SUM of the operations' gas limits: three operations at 1 040 000 each
 * fail with `gas_limit_too_high` + `gas_exhausted.block`.
 *
 * So the batch is sized by accumulated estimated gas, never by a fixed count
 * of operations. `MAX_BATCH_SIZE = 100` is not dangerous, it is four times
 * too conservative: batches of 448 transfers run on mainnet at 90.6% of the
 * block gas limit.
 */

export interface BatchPlanEntry extends EstimatedTransfer {}

export interface PlannedBatch {
  readonly index: number;
  readonly transfers: readonly BatchPlanEntry[];
  readonly totalGas: bigint;
  readonly totalStorage: bigint;
  readonly totalAmount: Mutez;
  readonly totalFees: Mutez;
  readonly totalBurn: Mutez;
}

export interface BatchPlan {
  readonly batches: readonly PlannedBatch[];
  /** Amount + fees + burn across every batch — what the baker must hold. */
  readonly totalCost: Mutez;
}

export interface PlanBatchesOptions {
  /**
   * Fraction of `hard_gas_limit_per_block` a single batch may occupy, as a
   * percentage. Below 100 to leave room for the block's other operations.
   */
  readonly blockGasUtilisationPercent?: number;
  /** Optional hard cap on operations per batch, for operational reasons. */
  readonly maxOperationsPerBatch?: number;
}

export function planBatches(
  transfers: readonly EstimatedTransfer[],
  constants: ProtocolConstants,
  options: PlanBatchesOptions = {},
): BatchPlan {
  const utilisation = BigInt(options.blockGasUtilisationPercent ?? 90);
  if (utilisation <= 0n || utilisation > 100n) {
    throw new InvariantViolationError(
      '0 < blockGasUtilisationPercent <= 100',
      `got ${options.blockGasUtilisationPercent}`,
    );
  }
  const gasBudget = (constants.hardGasLimitPerBlock * utilisation) / 100n;
  const maxOps = options.maxOperationsPerBatch ?? Number.MAX_SAFE_INTEGER;

  const batches: PlannedBatch[] = [];
  let current: EstimatedTransfer[] = [];
  let currentGas = 0n;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      index: batches.length,
      transfers: current,
      totalGas: current.reduce((sum, t) => sum + t.gasLimit, 0n),
      totalStorage: current.reduce((sum, t) => sum + t.storageLimit, 0n),
      totalAmount: sumMutez(current.map((t) => t.amount)),
      totalFees: sumMutez(current.map((t) => t.feeMutez)),
      totalBurn: sumMutez(current.map((t) => t.burnMutez)),
    });
    current = [];
    currentGas = 0n;
  };

  for (const transfer of transfers) {
    if (transfer.gasLimit > constants.hardGasLimitPerOperation) {
      throw new InvariantViolationError(
        'gasLimit <= hard_gas_limit_per_operation',
        `${transfer.address} needs ${transfer.gasLimit}, ceiling is ${constants.hardGasLimitPerOperation}`,
      );
    }
    if (transfer.gasLimit > gasBudget) {
      throw new InvariantViolationError(
        'a single operation fits in the batch gas budget',
        `${transfer.address} needs ${transfer.gasLimit}, budget is ${gasBudget} ` +
          `(${utilisation}% of hard_gas_limit_per_block ${constants.hardGasLimitPerBlock})`,
      );
    }
    if (transfer.storageLimit > constants.hardStorageLimitPerOperation) {
      throw new InvariantViolationError(
        'storageLimit <= hard_storage_limit_per_operation',
        `${transfer.address} needs ${transfer.storageLimit}, ceiling is ${constants.hardStorageLimitPerOperation}`,
      );
    }

    if (currentGas + transfer.gasLimit > gasBudget || current.length >= maxOps) {
      flush();
    }
    current.push(transfer);
    currentGas += transfer.gasLimit;
  }
  flush();

  return {
    batches,
    totalCost: sumMutez(
      batches.map((batch) => batch.totalAmount + batch.totalFees + batch.totalBurn),
    ),
  };
}

/**
 * The allocation burn for a destination that does not exist yet:
 * `origination_size * cost_per_byte`, both read from the chain. Confirmed
 * against real operations reporting `allocationFee: 64250`.
 */
export function allocationBurn(constants: ProtocolConstants): Mutez {
  return BigInt(constants.originationSize) * constants.costPerByte;
}

/** Refuses to sign a plan the baker cannot fund. Checked every run, no cache. */
export function assertBalanceCovers(plan: BatchPlan, bakerBalance: Mutez): void {
  if (bakerBalance < plan.totalCost) {
    throw new InvariantViolationError(
      'baker balance >= amounts + fees + burns',
      `balance ${bakerBalance} mutez is short of ${plan.totalCost} mutez by ` +
        `${plan.totalCost - bakerBalance} mutez`,
    );
  }
}

/** Every batch must respect the block ceiling. Cheap to re-check before sending. */
export function assertBatchesFit(plan: BatchPlan, constants: ProtocolConstants): void {
  for (const batch of plan.batches) {
    if (batch.totalGas > constants.hardGasLimitPerBlock) {
      throw new InvariantViolationError(
        'sum(gas_limit) <= hard_gas_limit_per_block',
        `batch ${batch.index} totals ${batch.totalGas}, ceiling is ${constants.hardGasLimitPerBlock}`,
      );
    }
  }
}
