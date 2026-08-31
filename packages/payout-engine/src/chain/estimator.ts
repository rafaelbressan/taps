import type { TezosToolkit } from '@taquito/taquito';
import {
  InvariantViolationError,
  estimateTransfers,
  type EstimatedTransfer,
  type ProtocolConstants,
  type Recipient,
} from '@tezos-suite/chain';
import type { EstimateTransfers } from '../engine';

/**
 * Estimation for a whole distribution.
 *
 * `estimate.batch()` is one round trip, which is what the rule asks for — but
 * a simulation is executed by the node and is bounded by the same block gas
 * ceiling as a real batch. A baker with 60 258 delegators cannot be estimated
 * in a single call by anyone. So the recipients are split into chunks that
 * fit the ceiling READ FROM THE CHAIN, and each chunk is one call.
 *
 * The number of recipients per chunk is therefore derived, never written:
 * it moves when gas repricing moves it.
 */

export interface ChunkedEstimatorOptions {
  /** Gas headroom over the node's estimate, in percent. */
  readonly gasBufferPercent?: number;
  /** Fraction of `hard_gas_limit_per_block` one simulation may fill. */
  readonly blockGasUtilisationPercent?: number;
  /** Recipients in the first, exploratory chunk used to learn the gas cost. */
  readonly probeSize?: number;
}

export function createChunkedEstimator(
  tezos: TezosToolkit,
  constants: ProtocolConstants,
  options: ChunkedEstimatorOptions = {},
): EstimateTransfers {
  const utilisation = BigInt(options.blockGasUtilisationPercent ?? 90);
  if (utilisation <= 0n || utilisation > 100n) {
    throw new InvariantViolationError(
      '0 < blockGasUtilisationPercent <= 100',
      `got ${options.blockGasUtilisationPercent}`,
    );
  }
  const gasBudget = (constants.hardGasLimitPerBlock * utilisation) / 100n;
  const probeSize = Math.max(1, options.probeSize ?? 10);

  return async (recipients: readonly Recipient[]): Promise<EstimatedTransfer[]> => {
    if (recipients.length === 0) return [];

    const probe = await estimateTransfers(tezos, recipients.slice(0, probeSize), {
      gasBufferPercent: options.gasBufferPercent,
    });
    const worstGas = probe.reduce((max, t) => (t.gasLimit > max ? t.gasLimit : max), 1n);
    const perChunk = Number(gasBudget / worstGas);
    if (perChunk < 1) {
      throw new InvariantViolationError(
        'at least one transfer fits the simulation gas budget',
        `one transfer needs ${worstGas} gas, budget is ${gasBudget}`,
      );
    }

    const estimates: EstimatedTransfer[] = [...probe];
    for (let start = probe.length; start < recipients.length; start += perChunk) {
      const chunk = recipients.slice(start, start + perChunk);
      estimates.push(
        ...(await estimateTransfers(tezos, chunk, {
          gasBufferPercent: options.gasBufferPercent,
        })),
      );
    }

    if (estimates.length !== recipients.length) {
      throw new InvariantViolationError(
        'one estimate per recipient',
        `asked for ${recipients.length}, produced ${estimates.length}`,
      );
    }
    return estimates;
  };
}
