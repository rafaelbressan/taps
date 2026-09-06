import type { Mutez } from '@tezos-suite/chain';
import type { SqlRow, SqlValue } from './db';

/**
 * Reading a value out of a row, with the type stated rather than assumed.
 *
 * The driver is told to return integers as `bigint`, so a mutez column comes
 * back exact. These helpers exist so that a column that is unexpectedly NULL
 * raises here, at the row, instead of turning into `0` and being paid.
 */

export class RowDecodeError extends Error {
  constructor(column: string, value: unknown, expected: string) {
    super(
      `a coluna ${column} veio como ${describe(value)} e deveria ser ${expected} — ` +
        'ler um valor de dinheiro que não é o que se espera é como o sistema antigo ' +
        'pagava zero em silêncio',
    );
    this.name = 'RowDecodeError';
  }
}

function describe(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return 'ausente';
  return `${typeof value} (${String(value)})`;
}

export function bigintOf(row: SqlRow, column: string): bigint {
  const value = row[column];
  if (typeof value === 'bigint') return value;
  // A driver that hands back a JS number for an INTEGER column is exact only
  // below 2^53. Refuse rather than round.
  throw new RowDecodeError(column, value, 'um inteiro (bigint)');
}

export function mutezOf(row: SqlRow, column: string): Mutez {
  return bigintOf(row, column);
}

export function intOf(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  throw new RowDecodeError(column, value, 'um inteiro');
}

export function intOrNull(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return intOf(row, column);
}

export function textOf(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new RowDecodeError(column, value, 'texto');
}

export function textOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return textOf(row, column);
}

export function boolOf(row: SqlRow, column: string): boolean {
  return intOf(row, column) !== 0;
}

export function dateOf(row: SqlRow, column: string): Date {
  return new Date(textOf(row, column));
}

export function dateOrNull(row: SqlRow, column: string): Date | null {
  const value = textOrNull(row, column);
  return value === null ? null : new Date(value);
}

export const bool = (value: boolean): SqlValue => (value ? 1 : 0);
export const iso = (value: Date): SqlValue => value.toISOString();
export const isoOrNull = (value: Date | null): SqlValue =>
  value === null ? null : value.toISOString();

/**
 * `params` and `destinations` of an audit event, as JSON.
 *
 * `JSON.stringify` cannot represent a bigint at all — it throws — and an audit
 * row is the one place a caller is most likely to hand one over, since it is
 * describing a payment. Tagging is the same scheme `FilePayoutStore` uses, so
 * the two durable stores read each other's audit trail.
 */
const BIGINT_TAG = ' bigint:';
const DATE_TAG = ' date:';

export function encodeJson(value: unknown): string {
  return JSON.stringify(value, function encode(this: Record<string, unknown>, key: string, raw: unknown) {
    const original = this[key];
    if (typeof original === 'bigint') return `${BIGINT_TAG}${original}`;
    if (original instanceof Date) return `${DATE_TAG}${original.toISOString()}`;
    return raw;
  });
}

export function decodeJson<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value !== 'string') return value;
    if (value.startsWith(BIGINT_TAG)) return BigInt(value.slice(BIGINT_TAG.length));
    if (value.startsWith(DATE_TAG)) return new Date(value.slice(DATE_TAG.length));
    return value;
  }) as T;
}
