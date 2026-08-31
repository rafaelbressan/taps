import type { TezosToolkit } from '@taquito/taquito';
import {
  InvariantViolationError,
  estimateTransfers,
  type EstimatedTransfer,
  type Mutez,
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
  /**
   * Balance of the paying account, in mutez.
   *
   * Gas is not the only ceiling on how many operations one `estimate.batch()`
   * call may carry. The simulation runs each operation at
   * `hard_storage_limit_per_operation`, so it charges an imaginary burn of
   * `hard_storage_limit * cost_per_byte` PER OPERATION against the real
   * balance — 15 XTZ each on Bakingnet today. A baker holding 494 XTZ can
   * therefore only have about 32 operations simulated at once, however
   * little gas they use, and asking for more comes back as
   * `subtraction_underflow` from the node rather than as anything about
   * balance.
   *
   * Measured on Bakingnet on 2026-08-31: 126 recipients in one call failed
   * exactly this way while the real cost was 343 XTZ against 494 available.
   *
   * Omitted means "gas is the only bound", which is right only for a source
   * rich enough that the imaginary burn cannot exhaust it.
   */
  readonly sourceBalanceMutez?: Mutez;
}

/**
 * How many operations one simulation may carry before its imaginary burn
 * exhausts the source. Half the arithmetic maximum, because the simulation
 * also subtracts the real amounts being transferred.
 */
function simulationBudget(
  constants: ProtocolConstants,
  sourceBalanceMutez: Mutez | undefined,
): bigint {
  if (sourceBalanceMutez === undefined) return BigInt(Number.MAX_SAFE_INTEGER);
  const burnPerOperation = constants.hardStorageLimitPerOperation * constants.costPerByte;
  if (burnPerOperation <= 0n) return BigInt(Number.MAX_SAFE_INTEGER);
  const budget = sourceBalanceMutez / (2n * burnPerOperation);
  return budget > 0n ? budget : 1n;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
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
  const probeCeiling = Number(simulationBudget(constants, options.sourceBalanceMutez));
  const probeSize = Math.max(1, Math.min(options.probeSize ?? 10, probeCeiling));

  return async (recipients: readonly Recipient[]): Promise<EstimatedTransfer[]> => {
    if (recipients.length === 0) return [];

    const probe = await estimateTransfers(tezos, recipients.slice(0, probeSize), {
      gasBufferPercent: options.gasBufferPercent,
    });
    const worstGas = probe.reduce((max, t) => (t.gasLimit > max ? t.gasLimit : max), 1n);
    const byGas = gasBudget / worstGas;
    const perChunk = Number(
      minBigInt(byGas, simulationBudget(constants, options.sourceBalanceMutez)),
    );
    if (perChunk < 1) {
      throw new InvariantViolationError(
        'at least one transfer fits the simulation budget',
        `one transfer needs ${worstGas} gas against a budget of ${gasBudget}, and the ` +
          `source balance allows ${simulationBudget(constants, options.sourceBalanceMutez)} ` +
          'operations per simulation',
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
