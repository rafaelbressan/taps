import { FieldTypeError, MissingFieldError } from '../errors';

/**
 * Field readers for external payloads. There is deliberately no variant that
 * returns a fallback.
 *
 * `data.ownBlockRewards || 0` is the single line that made every baker's
 * total come out as zero: eight of the eight fields the old client summed
 * had been removed from the API, and each `|| 0` turned a removed field into
 * a plausible number. The system then reported success.
 */

export function requirePresent(
  source: Record<string, unknown>,
  field: string,
  where: string,
): unknown {
  if (!(field in source)) {
    throw new MissingFieldError(field, where);
  }
  const value = source[field];
  if (value === null || value === undefined) {
    throw new MissingFieldError(field, where, `present but ${String(value)}`);
  }
  return value;
}

/** Integer mutez (or gas, or a count used in money arithmetic), as bigint. */
export function requireMutez(
  source: Record<string, unknown>,
  field: string,
  where: string,
): bigint {
  const value = requirePresent(source, field, where);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new FieldTypeError(field, where, 'an integer number of mutez', value);
    }
    if (!Number.isSafeInteger(value)) {
      throw new FieldTypeError(
        field,
        where,
        'an integer within Number.MAX_SAFE_INTEGER (JSON parsed it lossily)',
        value,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new FieldTypeError(field, where, 'an integer number of mutez', value);
}

export function requireInteger(
  source: Record<string, unknown>,
  field: string,
  where: string,
): number {
  const value = requirePresent(source, field, where);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new FieldTypeError(field, where, 'an integer', value);
  }
  return value;
}

export function requireString(
  source: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = requirePresent(source, field, where);
  if (typeof value !== 'string') {
    throw new FieldTypeError(field, where, 'a string', value);
  }
  return value;
}

export function requireBoolean(
  source: Record<string, unknown>,
  field: string,
  where: string,
): boolean {
  const value = requirePresent(source, field, where);
  if (typeof value !== 'boolean') {
    throw new FieldTypeError(field, where, 'a boolean', value);
  }
  return value;
}

export function requireArray(
  source: Record<string, unknown>,
  field: string,
  where: string,
): unknown[] {
  const value = requirePresent(source, field, where);
  if (!Array.isArray(value)) {
    throw new FieldTypeError(field, where, 'an array', value);
  }
  return value;
}

export function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FieldTypeError('(element)', where, 'an object', value);
  }
  return value as Record<string, unknown>;
}
