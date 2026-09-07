import { MIGRATIONS, type Migration } from './migrations';
import { SqlDriverError, type SqlDatabase, type SqlValue } from './db';

/**
 * The migration runner.
 *
 * It refuses more often than it runs, and every refusal is a data-loss
 * scenario someone would otherwise discover after the fact:
 *
 * - A database at a version this build does not know about is **newer than the
 *   code**. That happens when a baker opens an old copy of the app on a
 *   restored backup. Running the old code against the new schema would write
 *   rows the new schema no longer means. It stops.
 * - A version already applied whose recorded name differs from this build's is
 *   a migration that was **edited after shipping**. The two machines no longer
 *   have the same schema even though both say version N. It stops.
 * - Each migration runs in its own transaction together with its bookkeeping
 *   row, so a crash halfway leaves the previous version, never a half-applied
 *   one.
 */

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: Date;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const BOOKKEEPING = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER NOT NULL PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
)`;

export async function readAppliedMigrations(
  db: SqlDatabase,
): Promise<AppliedMigration[]> {
  await db.execute(BOOKKEEPING);
  const rows = await db.query(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
  );
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    appliedAt: new Date(String(row.applied_at)),
  }));
}

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
}

export async function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): Promise<MigrateResult> {
  assertOrdered(migrations);

  const applied = await readAppliedMigrations(db);
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  const from = applied.length === 0 ? 0 : Math.max(...applied.map((a) => a.version));

  for (const record of applied) {
    const migration = known.get(record.version);
    if (!migration) {
      throw new MigrationError(
        `o banco está na versão ${record.version} ("${record.name}"), que esta versão ` +
          'do TAPS não conhece — ele foi escrito por uma versão mais nova. Atualize o ' +
          'aplicativo antes de abrir este banco; abrir assim mesmo apagaria dados que ' +
          'esta versão não sabe ler.',
      );
    }
    if (migration.name !== record.name) {
      throw new MigrationError(
        `a migration ${record.version} foi aplicada como "${record.name}" e neste ` +
          `binário se chama "${migration.name}" — uma migration foi editada depois de ` +
          'publicada, e as duas máquinas não têm mais o mesmo schema.',
      );
    }
  }

  const pending = migrations.filter(
    (migration) => !applied.some((record) => record.version === migration.version),
  );

  for (const migration of pending) {
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(migration.sql)) {
        await tx.execute(statement);
      }
      await tx.execute(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, now().toISOString()] as SqlValue[],
      );
    });
  }

  return {
    from,
    to: migrations.length === 0 ? from : migrations[migrations.length - 1]!.version,
    applied: pending.map((migration) => migration.version),
  };
}

function assertOrdered(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (migration.version <= previous) {
      throw new MigrationError(
        `as migrations precisam estar em ordem crescente e sem repetição; ` +
          `${migration.version} vem depois de ${previous}`,
      );
    }
    previous = migration.version;
  }
}

/**
 * Splits a migration into statements.
 *
 * The driver executes one statement per call — the desktop bridge cannot do
 * otherwise — so the SQL is split here. It is a deliberately simple split on
 * `;` outside of quotes and comments, and it is enough because migrations in
 * this file are DDL: there is no trigger body and no `BEGIN ... END`. A
 * migration that needs one has to teach this function about it first, which
 * is the point of it raising rather than guessing.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }

  if (quote) {
    throw new MigrationError('a migration tem uma aspa não fechada');
  }
  if (/\bBEGIN\b/i.test(sql)) {
    throw new MigrationError(
      'esta migration contém BEGIN — o separador simples por ";" não sabe onde termina ' +
        'um corpo de trigger, e dividiria a migration no lugar errado',
    );
  }

  const trimmed = statements.map((statement) => statement.trim()).filter(Boolean);
  const tail = current.trim();
  if (tail) trimmed.push(tail);
  if (trimmed.length === 0) {
    throw new SqlDriverError('migration vazia');
  }
  return trimmed;
}
