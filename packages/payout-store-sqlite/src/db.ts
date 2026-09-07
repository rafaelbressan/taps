/**
 * The SQLite handle, as a port.
 *
 * It is a port and not a concrete class because the same store has to run in
 * two places that cannot share a driver: the Node process that the QA harness
 * and the command line use, and the desktop app, where the database file is
 * owned by the Rust side and reached over the Tauri command bridge. Both give
 * the same guarantees — one connection, one writer, real transactions — so the
 * store above them is written once.
 *
 * Everything is async because the desktop side crosses a process boundary.
 * `node:sqlite` is synchronous underneath and simply resolves immediately.
 */

/** What SQLite itself can hold. Money is `bigint`, always. */
export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
}

/**
 * A connection inside an open transaction.
 *
 * The store never issues `BEGIN` or `COMMIT` itself: it asks for a
 * transaction and receives this. A driver that cannot hold a transaction open
 * across several statements is not an implementation of this interface, which
 * is the point — "the settlement lands whole or not at all" is a claim about
 * the transaction, not about the order the store happens to write in.
 */
export interface SqlTransaction {
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  execute(sql: string, params?: readonly SqlValue[]): Promise<void>;
}

export interface SqlDatabase extends SqlTransaction {
  /**
   * Runs `body` inside one transaction. It commits when `body` returns and
   * rolls back when it throws — including when the throw is a constraint the
   * database itself raised.
   *
   * Nesting is not supported and must raise: a "nested transaction" that
   * silently joins the outer one turns a rollback into a partial write.
   */
  transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Raised when a driver is asked for something it cannot honour. */
export class SqlDriverError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqlDriverError';
  }
}
