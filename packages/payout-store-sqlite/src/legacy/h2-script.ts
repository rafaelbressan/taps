/**
 * Reading the database of the version being replaced.
 *
 * The old TAPS keeps its data in an embedded H2 database
 * (`jdbc:h2:{path}/database/tapsDB;MODE=MySQL`). H2's file format is a Java
 * artefact with no reader outside the JVM, so the migration does not try to
 * open it: the baker exports the database with one command the H2 console
 * already offers —
 *
 *     SCRIPT TO 'taps-export.sql'
 *
 * — and this module reads that export. The reason is worth stating plainly:
 * an importer that shells out to a JVM would fail on the machine of every
 * baker who upgraded away from Java, and the export is text that the baker can
 * read, keep and re-run.
 *
 * The parser deliberately understands only what an H2 `SCRIPT` emits for these
 * six tables. Anything it does not recognise raises with the line, instead of
 * being skipped — a silently skipped `INSERT` is a cycle of payment history
 * that quietly does not exist any more.
 */

export class LegacyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyParseError';
  }
}

/** A value exactly as the export wrote it. Numbers stay strings on purpose. */
export type LegacyValue = { kind: 'null' } | { kind: 'text'; value: string } | { kind: 'number'; text: string } | { kind: 'bool'; value: boolean };

export interface LegacyRow {
  readonly table: string;
  readonly values: ReadonlyMap<string, LegacyValue>;
}

const INSERT = /INSERT\s+INTO\s+(?:"?[A-Za-z0-9_]+"?\s*\.\s*)?"?([A-Za-z0-9_]+)"?\s*\(([^)]*)\)\s*VALUES/giu;

/**
 * Every row of every `INSERT` in an H2 script export, in file order.
 *
 * Table and column names are lower-cased: H2 upper-cases unquoted identifiers,
 * so `delegatorsPayments` comes back as `DELEGATORSPAYMENTS`.
 */
export function parseH2Script(text: string): LegacyRow[] {
  const rows: LegacyRow[] = [];
  INSERT.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INSERT.exec(text)) !== null) {
    const table = match[1]!.toLowerCase();
    const columns = match[2]!
      .split(',')
      .map((column) => column.trim().replace(/^"|"$/g, '').toLowerCase());

    let cursor = INSERT.lastIndex;
    for (;;) {
      cursor = skipSpace(text, cursor);
      if (text[cursor] !== '(') break;
      const { values, next } = readTuple(text, cursor, table);
      if (values.length !== columns.length) {
        throw new LegacyParseError(
          `a tabela ${table} declarou ${columns.length} colunas e a linha trouxe ` +
            `${values.length} valores — o arquivo exportado não bate com o esperado`,
        );
      }
      rows.push({
        table,
        values: new Map(columns.map((column, index) => [column, values[index]!])),
      });
      cursor = skipSpace(text, next);
      if (text[cursor] === ',') {
        cursor += 1;
        continue;
      }
      break;
    }
    INSERT.lastIndex = cursor;
  }

  return rows;
}

function skipSpace(text: string, index: number): number {
  let cursor = index;
  for (;;) {
    while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
    if (text.startsWith('--', cursor)) {
      const end = text.indexOf('\n', cursor);
      cursor = end === -1 ? text.length : end + 1;
      continue;
    }
    return cursor;
  }
}

function readTuple(
  text: string,
  open: number,
  table: string,
): { values: LegacyValue[]; next: number } {
  const values: LegacyValue[] = [];
  let cursor = open + 1;

  for (;;) {
    cursor = skipSpace(text, cursor);
    const { value, next } = readValue(text, cursor, table);
    values.push(value);
    cursor = skipSpace(text, next);
    const char = text[cursor];
    if (char === ',') {
      cursor += 1;
      continue;
    }
    if (char === ')') return { values, next: cursor + 1 };
    throw new LegacyParseError(
      `esperava "," ou ")" na tabela ${table} e encontrei ${JSON.stringify(char ?? 'fim do arquivo')}`,
    );
  }
}

/** Type prefixes H2 writes before a literal, all of which wrap a string. */
const TYPED_LITERAL = /^(TIMESTAMP WITH TIME ZONE|TIMESTAMP|DATE|TIME)\b\s*/iu;

function readValue(
  text: string,
  start: number,
  table: string,
): { value: LegacyValue; next: number } {
  const rest = text.slice(start);

  const typed = TYPED_LITERAL.exec(rest);
  if (typed && rest[typed[0].length] === "'") {
    const inner = readString(text, start + typed[0].length, table);
    return { value: { kind: 'text', value: inner.value }, next: inner.next };
  }

  if (text[start] === "'") {
    const inner = readString(text, start, table);
    return { value: { kind: 'text', value: inner.value }, next: inner.next };
  }

  const word = /^(NULL|TRUE|FALSE)\b/iu.exec(rest);
  if (word) {
    const token = word[1]!.toUpperCase();
    const value: LegacyValue =
      token === 'NULL' ? { kind: 'null' } : { kind: 'bool', value: token === 'TRUE' };
    return { value, next: start + word[0].length };
  }

  // A number is kept as the exact characters the export wrote. Parsing it into
  // a JS number here would round 125.543210 before anyone could convert it to
  // mutez, which is the precise defect this migration exists to not repeat.
  const numeric = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/u.exec(rest);
  if (numeric) {
    return { value: { kind: 'number', text: numeric[0] }, next: start + numeric[0].length };
  }

  throw new LegacyParseError(
    `não entendi o valor que começa em ${JSON.stringify(rest.slice(0, 24))} na tabela ${table}`,
  );
}

function readString(
  text: string,
  start: number,
  table: string,
): { value: string; next: number } {
  let cursor = start + 1;
  let value = '';
  for (;;) {
    if (cursor >= text.length) {
      throw new LegacyParseError(`aspa não fechada na tabela ${table}`);
    }
    const char = text[cursor]!;
    if (char === "'") {
      if (text[cursor + 1] === "'") {
        value += "'";
        cursor += 2;
        continue;
      }
      return { value, next: cursor + 1 };
    }
    value += char;
    cursor += 1;
  }
}

export function requireText(row: LegacyRow, column: string): string {
  const value = row.values.get(column);
  if (!value || value.kind === 'null') {
    throw new LegacyParseError(
      `a coluna ${column} da tabela ${row.table} veio vazia, e ela é parte da chave`,
    );
  }
  return value.kind === 'text' ? value.value : String(describe(value));
}

export function optionalText(row: LegacyRow, column: string): string | null {
  const value = row.values.get(column);
  if (!value || value.kind === 'null') return null;
  return value.kind === 'text' ? value.value : describe(value);
}

/** The literal characters of a numeric column, for exact conversion. */
export function requireNumericText(row: LegacyRow, column: string): string {
  const value = row.values.get(column);
  if (!value || value.kind === 'null') {
    throw new LegacyParseError(
      `a coluna ${column} da tabela ${row.table} está vazia — ` +
        'no sistema antigo ela guarda um valor monetário, e tratar ausência como zero ' +
        'é exatamente como o cálculo antigo pagava zero em silêncio',
    );
  }
  if (value.kind !== 'number') {
    throw new LegacyParseError(
      `a coluna ${column} da tabela ${row.table} não é um número: ${describe(value)}`,
    );
  }
  return value.text;
}

export function requireInteger(row: LegacyRow, column: string): number {
  const text = requireNumericText(row, column);
  if (!/^-?\d+$/u.test(text)) {
    throw new LegacyParseError(
      `a coluna ${column} da tabela ${row.table} deveria ser inteira e veio "${text}"`,
    );
  }
  return Number(text);
}

export function requireBool(row: LegacyRow, column: string, fallback: boolean): boolean {
  const value = row.values.get(column);
  if (!value || value.kind === 'null') return fallback;
  if (value.kind === 'bool') return value.value;
  if (value.kind === 'number') return value.text !== '0';
  throw new LegacyParseError(
    `a coluna ${column} da tabela ${row.table} não é um booleano: ${describe(value)}`,
  );
}

function describe(value: LegacyValue): string {
  switch (value.kind) {
    case 'null':
      return 'NULL';
    case 'text':
      return value.value;
    case 'number':
      return value.text;
    case 'bool':
      return value.value ? 'TRUE' : 'FALSE';
  }
}
