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

/**
 * What it costs to reveal the paying account, when it never has been.
 *
 * A Tezos account has to publish its public key once before it can send
 * anything, and Taquito puts that reveal in front of the batch it is asked to
 * estimate. The first payout of a freshly created payout key is therefore the
 * one that meets this — which is the worst moment to meet anything.
 */
export interface RevealCost {
  readonly gasLimit: bigint;
  readonly storageLimit: bigint;
  readonly feeMutez: Mutez;
}

export interface EstimatedBatch {
  readonly transfers: readonly EstimatedTransfer[];
  /** Non-null only while the paying account has never been revealed. */
  readonly reveal: RevealCost | null;
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
 *
 * # Why the count is not simply `recipients.length` (BRES-137)
 *
 * When the paying account has never been revealed, Taquito prepends a reveal
 * and answers with one estimate MORE than it was asked for. The old check
 * read that as a broken invariant and stopped the payout — which meant the
 * first payout of any new payout key failed, and failed with a sentence about
 * an invariant instead of about the account.
 *
 * The number is not guessed from the difference: the account is asked. A
 * count that happens to be off by one for any other reason must still be a
 * refusal, because the alternative is pairing estimates with the wrong
 * recipients — one delegator paid another delegator's gas, silently.
 */
export async function estimateTransfers(
  tezos: TezosToolkit,
  recipients: readonly Recipient[],
  options: EstimateBatchOptions = {},
): Promise<EstimatedBatch> {
  if (recipients.length === 0) return { transfers: [], reveal: null };
  const gasBufferPercent = options.gasBufferPercent ?? 0;

  const source = await tezos.signer.publicKeyHash();
  const managerKey = await tezos.rpc.getManagerKey(source);
  // `null` from the node means "never revealed". Taquito also answers with an
  // object for some key types, so the test is presence, not shape.
  const revealed = managerKey !== null && managerKey !== undefined && managerKey !== '';

  const estimates = await tezos.estimate.batch(
    recipients.map((recipient) => ({
      kind: OpKind.TRANSACTION as const,
      to: recipient.address,
      amount: mutezToTaquitoAmount(recipient.amount),
      mutez: true,
    })),
  );

  // The reveal comes first, because on chain it has to: the operations it
  // authorises cannot be checked before the key they are checked against.
  const revealOffset = revealed ? 0 : 1;
  if (estimates.length !== recipients.length + revealOffset) {
    throw new InvariantViolationError(
      'estimate.batch returns one estimate per operation',
      `asked for ${recipients.length} transfers from ${source} ` +
        `(${revealed ? 'revealed' : 'never revealed, so a reveal is expected'}), ` +
        `got ${estimates.length} estimates`,
    );
  }

  const revealEstimate = revealed ? null : estimates[0]!;
  const reveal: RevealCost | null = revealEstimate
    ? {
        gasLimit: toBigInt(revealEstimate.gasLimit, 'gasLimit'),
        storageLimit: toBigInt(revealEstimate.storageLimit, 'storageLimit'),
        feeMutez: toBigInt(revealEstimate.suggestedFeeMutez, 'suggestedFeeMutez'),
      }
    : null;

  const transfers = recipients.map((recipient, index) => {
    const estimate = estimates[index + revealOffset]!;
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

  return { transfers, reveal };
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
