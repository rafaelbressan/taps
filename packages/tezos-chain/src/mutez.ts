import { ChainLayerError } from './errors';

/**
 * Every monetary value in this package is mutez as `bigint`. There is no
 * `number` anywhere in the money path: `Math.floor(0.00397 * 1e6)` yields
 * 3969 instead of 3970, and that error is systematic and always downward.
 *
 * XTZ only exists at the display edge, as a string.
 */
export type Mutez = bigint;

export const MUTEZ_DECIMALS = 6;
const MUTEZ_PER_TEZ = 1_000_000n;

export class MutezParseError extends ChainLayerError {}

/**
 * Parse a decimal XTZ amount written as a string. Strings, never `number`:
 * a float literal has already lost the value before this function is called.
 */
export function tezToMutez(tez: string): Mutez {
  const text = tez.trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    throw new MutezParseError(
      `"${tez}" is not a decimal XTZ amount (expected e.g. "0.00397")`,
    );
  }
  const [, sign, whole, fractionRaw = ''] = match;
  if (fractionRaw.length > MUTEZ_DECIMALS) {
    throw new MutezParseError(
      `"${tez}" has ${fractionRaw.length} decimals; mutez has ${MUTEZ_DECIMALS} — ` +
        'refusing to round a monetary value silently',
    );
  }
  const fraction = fractionRaw.padEnd(MUTEZ_DECIMALS, '0');
  const magnitude = BigInt(whole!) * MUTEZ_PER_TEZ + BigInt(fraction);
  return sign === '-' ? -magnitude : magnitude;
}

/** Display edge only. Never feed the result back into arithmetic. */
export function formatMutezAsTez(mutez: Mutez): string {
  const negative = mutez < 0n;
  const magnitude = negative ? -mutez : mutez;
  const whole = magnitude / MUTEZ_PER_TEZ;
  const fraction = (magnitude % MUTEZ_PER_TEZ)
    .toString()
    .padStart(MUTEZ_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Taquito wants an integer amount; `mutez: true` plus this keeps it exact. */
export function mutezToTaquitoAmount(mutez: Mutez): number {
  if (mutez < 0n) {
    throw new MutezParseError(`negative amount ${mutez} cannot be transferred`);
  }
  if (mutez > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MutezParseError(
      `${mutez} mutez exceeds Number.MAX_SAFE_INTEGER and cannot cross Taquito's number API`,
    );
  }
  return Number(mutez);
}

export function sumMutez(values: Iterable<Mutez>): Mutez {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
