import { OpKind, type TezosToolkit } from '@taquito/taquito';
import { InvariantViolationError } from '../errors';
import type { Mutez } from '../mutez';
import { mutezToTaquitoAmount } from '../mutez';

/**
 * One `estimate.batch()` call for the whole distribution. Not one call per
 * recipient, and never a default when it fails: `DEFAULT_GAS_LIMIT = 15400`
 * against a measured 2101 is 7x too much, and gas that is too high does not
 * only cost more — it shrinks the batch, because the ceiling that binds is
 * the block's.
 */

export interface Recipient {
  readonly address: string;
  readonly amount: Mutez;
  /** Emptied or never-allocated destinations need storage for the burn. */
  readonly emptied?: boolean;
}

export interface EstimatedTransfer {
  readonly address: string;
  readonly amount: Mutez;
  readonly gasLimit: bigint;
  /**
   * Never 0 by assumption. `storage_limit: 0` against a destination that is
   * not allocated makes the WHOLE batch come back `backtracked`, and the
   * other recipients show no error of their own.
   */
  readonly storageLimit: bigint;
  readonly feeMutez: Mutez;
  /** `origination_size * cost_per_byte` when the destination is allocated. */
  readonly burnMutez: Mutez;
}

export interface EstimateBatchOptions {
  /** Extra gas headroom per operation, as a percentage. Applied to gas only. */
  readonly gasBufferPercent?: number;
}

function toBigInt(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvariantViolationError(
      `estimate.${field} is a non-negative integer`,
      `got ${value}`,
    );
  }
  return BigInt(value);
}

/**
 * Estimates every transfer in a single round trip and returns exactly what
 * the node said, with an explicit gas buffer if the caller asks for one.
 */
export async function estimateTransfers(
  tezos: TezosToolkit,
  recipients: readonly Recipient[],
  options: EstimateBatchOptions = {},
): Promise<EstimatedTransfer[]> {
  if (recipients.length === 0) return [];
  const gasBufferPercent = options.gasBufferPercent ?? 0;

  const estimates = await tezos.estimate.batch(
    recipients.map((recipient) => ({
      kind: OpKind.TRANSACTION as const,
      to: recipient.address,
      amount: mutezToTaquitoAmount(recipient.amount),
      mutez: true,
    })),
  );

  if (estimates.length !== recipients.length) {
    throw new InvariantViolationError(
      'estimate.batch returns one estimate per operation',
      `asked for ${recipients.length}, got ${estimates.length}`,
    );
  }

  return recipients.map((recipient, index) => {
    const estimate = estimates[index]!;
    const gas = toBigInt(estimate.gasLimit, 'gasLimit');
    return {
      address: recipient.address,
      amount: recipient.amount,
      gasLimit: gas + (gas * BigInt(gasBufferPercent)) / 100n,
      storageLimit: toBigInt(estimate.storageLimit, 'storageLimit'),
      feeMutez: toBigInt(estimate.suggestedFeeMutez, 'suggestedFeeMutez'),
      burnMutez: toBigInt(estimate.burnFeeMutez, 'burnFeeMutez'),
    };
  });
}

/** Transfer parameters for Taquito, straight from the estimate. */
export function toTransferParams(transfer: EstimatedTransfer) {
  return {
    kind: OpKind.TRANSACTION as const,
    to: transfer.address,
    amount: mutezToTaquitoAmount(transfer.amount),
    mutez: true,
    gasLimit: Number(transfer.gasLimit),
    storageLimit: Number(transfer.storageLimit),
    fee: Number(transfer.feeMutez),
  };
}
