import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqlDriverError, type SqlDatabase, type SqlRow, type SqlTransaction, type SqlValue } from './db';

/**
 * `SqlDatabase` on `node:sqlite`.
 *
 * Three pragmas are set at open and none of them is decoration:
 *
 * - `journal_mode = WAL` — a crash between the write and the fsync leaves the
 *   last committed transaction, not a truncated file. The store's whole claim
 *   ("the hash is durable before the operation is injected") is a claim about
 *   what survives a kill, so the journal is part of the contract.
 * - `synchronous = FULL` — WAL's default (`NORMAL`) can lose the last commits
 *   on a machine power-cut. A lost commit here is a payout whose hash is not
 *   on record, which is the one failure this system exists to prevent. The
 *   cost is one fsync per transaction, on a database that writes a handful of
 *   times per cycle.
 * - `foreign_keys = ON` — SQLite ignores foreign keys unless asked, per
 *   connection. Without it the `RESTRICT` that stops a settled cycle from
 *   being deleted is a comment.
 */
export interface NodeSqliteOptions {
  /** Leave WAL off for a database on a filesystem that cannot do shared memory. */
  readonly walEnabled?: boolean;
}

export class NodeSqliteDatabase implements SqlDatabase {
  private readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(
    /** `:memory:` or a path. The directory is created if it is missing. */
    readonly location: string,
    options: NodeSqliteOptions = {},
  ) {
    if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
    this.db = new DatabaseSync(location);
    if (options.walEnabled !== false && location !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /** The live handle, for `VACUUM INTO` and `PRAGMA integrity_check`. */
  get handle(): DatabaseSync {
    return this.db;
  }

  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const statement = this.db.prepare(sql);
    // Without this a mutez column comes back as a `number` and a value above
    // 2^53 is silently wrong — exactly the class of defect the money rules
    // exist to remove.
    statement.setReadBigInts(true);
    return statement.all(...(params as SqlValue[])) as unknown as SqlRow[];
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as SqlValue[]));
  }

  /** Statements with no parameters, for the migration runner. */
  execScript(sql: string): void {
    this.db.exec(sql);
  }

  async transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      throw new SqlDriverError(
        'a transaction is already open on this connection — nesting would turn a ' +
          'rollback into a partial write',
      );
    }
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await body(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
