import { migrate, type MigrateResult } from './migrate';
import { NodeSqliteDatabase, type NodeSqliteOptions } from './node-sqlite';
import { SqlitePayoutStore } from './store';

/**
 * Opens the database and brings the schema up to date, in that order and
 * nowhere else.
 *
 * There is exactly one place that runs migrations, and it is here, at open.
 * The version being replaced had none at all and shipped a `prisma migrate
 * deploy` that created no table — a database whose schema depends on somebody
 * remembering a command is a database that will be missing on the machine that
 * matters.
 */
export interface OpenedDatabase {
  readonly db: NodeSqliteDatabase;
  readonly store: SqlitePayoutStore;
  readonly migration: MigrateResult;
}

export async function openPayoutDatabase(
  location: string,
  options: NodeSqliteOptions = {},
): Promise<OpenedDatabase> {
  const db = new NodeSqliteDatabase(location, options);
  try {
    const migration = await migrate(db);
    return { db, store: new SqlitePayoutStore(db), migration };
  } catch (error) {
    await db.close();
    throw error;
  }
}
