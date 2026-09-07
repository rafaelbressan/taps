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

/**
 * `INSERT INTO tabela (colunas) VALUES` — **e** `INSERT INTO tabela VALUES`.
 *
 * A lista de colunas é opcional porque o H2 mudou de ideia entre versões: a
 * 1.3.172, que é a do `.lex` do Lucee, escreve as colunas; a 1.4.200 não
 * escreve, e a ordem passa a vir do `CREATE TABLE` logo acima. Sem os dois
 * casos, o baker que instalou um H2 mais novo recebe "não encontrei nenhum
 * INSERT" sobre um arquivo perfeitamente válido.
 */
const INSERT =
  /INSERT\s+INTO\s+(?:"?[A-Za-z0-9_]+"?\s*\.\s*)?"?([A-Za-z0-9_]+)"?\s*(?:\(([^)]*)\)\s*)?VALUES/giu;

/** `CREATE [CACHED|MEMORY] TABLE [schema.]tabela(` — onde a ordem das colunas está. */
const CREATE =
  /CREATE\s+(?:CACHED\s+|MEMORY\s+|GLOBAL\s+TEMPORARY\s+|LOCAL\s+TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[A-Za-z0-9_]+"?\s*\.\s*)?"?([A-Za-z0-9_]+)"?\s*\(/giu;

/** Palavras que começam uma restrição, não uma coluna. */
const CONSTRAINT_WORDS = new Set([
  'primary',
  'constraint',
  'unique',
  'foreign',
  'key',
  'check',
  'index',
]);

/**
 * A ordem das colunas de cada tabela, lida dos `CREATE TABLE` do arquivo.
 *
 * Só é usada quando o `INSERT` vem sem lista de colunas. Ler o `CREATE` é a
 * única fonte que existe nesse caso — e é a mesma que o H2 usaria para
 * reimportar o arquivo.
 */
export function parseTableColumns(text: string): Map<string, string[]> {
  const byTable = new Map<string, string[]>();
  CREATE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = CREATE.exec(text)) !== null) {
    const table = match[1]!.toLowerCase();
    const open = CREATE.lastIndex - 1;
    const body = readParenthesised(text, open);
    if (body === null) continue;

    const columns: string[] = [];
    for (const part of splitTopLevel(body)) {
      const name = /^\s*"?([A-Za-z0-9_]+)"?/u.exec(part)?.[1];
      if (!name) continue;
      if (CONSTRAINT_WORDS.has(name.toLowerCase())) continue;
      columns.push(name.toLowerCase());
    }
    if (columns.length > 0) byTable.set(table, columns);
    CREATE.lastIndex = open + body.length + 2;
  }

  return byTable;
}

/** O conteúdo entre `(` em `open` e o `)` que o fecha, respeitando aspas. */
function readParenthesised(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let cursor = open; cursor < text.length; cursor += 1) {
    const char = text[cursor]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, cursor);
    }
  }
  return null;
}

/** Divide por vírgula no nível de cima: `DECIMAL(20, 6)` não conta. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let cursor = 0; cursor < body.length; cursor += 1) {
    const char = body[cursor]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, cursor));
      start = cursor + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * Every row of every `INSERT` in an H2 script export, in file order.
 *
 * Table and column names are lower-cased: H2 upper-cases unquoted identifiers,
 * so `delegatorsPayments` comes back as `DELEGATORSPAYMENTS`.
 */
export function parseH2Script(text: string): LegacyRow[] {
  const rows: LegacyRow[] = [];
  const declared = parseTableColumns(text);
  INSERT.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INSERT.exec(text)) !== null) {
    const table = match[1]!.toLowerCase();
    const listed = match[2];
    const columns =
      listed === undefined
        ? declared.get(table)
        : listed
            .split(',')
            .map((column) => column.trim().replace(/^"|"$/g, '').toLowerCase());
    if (!columns) {
      throw new LegacyParseError(
        `o INSERT da tabela ${table} não traz a lista de colunas e o arquivo não tem o ` +
          'CREATE TABLE dela — sem os dois não dá para saber a que coluna cada valor ' +
          'pertence, e adivinhar seria trocar um endereço por um valor',
      );
    }

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
