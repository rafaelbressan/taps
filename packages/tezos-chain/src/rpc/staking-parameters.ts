import { FieldTypeError, HttpError, MissingFieldError } from '../errors';
import type { NetworkConfig } from '../network';

/**
 * `edge_of_baking_over_staking_billionth` is per baker and lives on-chain at
 * `/context/delegates/{pkh}/active_staking_parameters`.
 *
 * It is a BILLIONTH. Reading 150 000 000 as a percentage gives 150 000 000 %.
 *
 * Do not use it to recompute the edge. The protocol applies the edge per
 * reward event, rounding each time; reconstructing it from the cycle total is
 * off by hundreds of mutez (706 measured on one Everstake cycle). Read the
 * reported `*StakedEdge` and `*StakedShared` instead. This value is for
 * display, for policy checks, and for detecting a pending change.
 */
export interface StakingParameters {
  readonly edgeOfBakingOverStakingBillionth: bigint;
  readonly limitOfStakingOverBakingMillionth: bigint;
}

export const BILLIONTH = 1_000_000_000n;
export const MILLIONTH = 1_000_000n;

const SOURCE = 'active_staking_parameters';

function requireBigInt(raw: Record<string, unknown>, field: string): bigint {
  if (!(field in raw) || raw[field] === null || raw[field] === undefined) {
    throw new MissingFieldError(field, SOURCE);
  }
  const value = raw[field];
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new FieldTypeError(field, SOURCE, 'an integer', value);
}

export function parseStakingParameters(raw: Record<string, unknown>): StakingParameters {
  return {
    edgeOfBakingOverStakingBillionth: requireBigInt(
      raw,
      'edge_of_baking_over_staking_billionth',
    ),
    limitOfStakingOverBakingMillionth: requireBigInt(
      raw,
      'limit_of_staking_over_baking_millionth',
    ),
  };
}

/** Display only — the payout never multiplies by this. */
export function edgeAsPercentString(parameters: StakingParameters): string {
  const basisPoints = (parameters.edgeOfBakingOverStakingBillionth * 10_000n) / BILLIONTH;
  const whole = basisPoints / 100n;
  const fraction = (basisPoints % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}%`;
}

export async function fetchStakingParameters(
  network: NetworkConfig,
  baker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StakingParameters> {
  const url = `${network.rpcUrl}/chains/main/blocks/head/context/delegates/${baker}/active_staking_parameters`;
  const response = await fetchImpl(url);
  const body = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, body);
  return parseStakingParameters(JSON.parse(body) as Record<string, unknown>);
}
