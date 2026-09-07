import { MIGRATIONS } from '../../src/migrations';
import { MigrationError, migrate, readAppliedMigrations, splitStatements } from '../../src/migrate';
import { NodeSqliteDatabase } from '../../src/node-sqlite';

/**
 * The version this replaces has `prisma/migrations/` containing a single
 * `.gitkeep`. `prisma migrate deploy` reports success and creates no table, so
 * the system starts, accepts a payout run and fails at the first query. These
 * tests are the ones that would have caught that.
 */
describe('migrations', () => {
  let db: NodeSqliteDatabase;
  beforeEach(() => {
    db = new NodeSqliteDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('creates the schema on an empty database', async () => {
    const result = await migrate(db);
    expect(result.from).toBe(0);
    expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.version));

    const tables = (
      await db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    ).map((row) => String(row.name));
    expect(tables).toEqual(
      expect.arrayContaining([
        'distributions',
        'delegator_lines',
        'batches',
        'batch_transfers',
        'batch_attempts',
        'carry_over',
        'debt_settlements',
        'operation_hashes',
        'audit',
        'legacy_payments',
        'schema_migrations',
      ]),
    );
  });

  it('is a no-op the second time', async () => {
    await migrate(db);
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    expect(await readAppliedMigrations(db)).toHaveLength(MIGRATIONS.length);
  });

  it('applies only what is missing', async () => {
    await migrate(db, MIGRATIONS.slice(0, 1));
    const result = await migrate(db);
    expect(result.from).toBe(1);
    expect(result.applied).toEqual(MIGRATIONS.slice(1).map((migration) => migration.version));
  });

  it('refuses a database written by a newer version', async () => {
    await migrate(db, [
      ...MIGRATIONS,
      { version: 99, name: 'do futuro', sql: 'CREATE TABLE futuro (a INTEGER)' },
    ]);
    await expect(migrate(db)).rejects.toBeInstanceOf(MigrationError);
    await expect(migrate(db)).rejects.toThrow(/versão mais nova/);
  });

  it('refuses a migration that was edited after shipping', async () => {
    await migrate(db);
    const tampered = MIGRATIONS.map((migration) =>
      migration.version === 1 ? { ...migration, name: 'outro nome' } : migration,
    );
    await expect(migrate(db, tampered)).rejects.toThrow(/editada depois de publicada/);
  });

  it('refuses migrations that are out of order', async () => {
    await expect(
      migrate(db, [
        { version: 2, name: 'b', sql: 'CREATE TABLE b (a INTEGER)' },
        { version: 1, name: 'a', sql: 'CREATE TABLE a (a INTEGER)' },
      ]),
    ).rejects.toBeInstanceOf(MigrationError);
  });

  it('leaves the previous version in place when a migration fails halfway', async () => {
    await migrate(db, MIGRATIONS.slice(0, 1));
    await expect(
      migrate(db, [
        ...MIGRATIONS.slice(0, 1),
        {
          version: 2,
          name: 'quebrada',
          sql: 'CREATE TABLE meia (a INTEGER); ISTO NAO E SQL;',
        },
      ]),
    ).rejects.toThrow();

    const applied = await readAppliedMigrations(db);
    expect(applied.map((entry) => entry.version)).toEqual([1]);
    const tables = (
      await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meia'")
    ).length;
    expect(tables).toBe(0);
  });

  describe('the statement splitter', () => {
    it('keeps a semicolon inside a string literal', () => {
      expect(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual([
        "INSERT INTO t VALUES ('a;b')",
        'SELECT 1',
      ]);
    });

    it('drops line comments', () => {
      expect(splitStatements('-- comentário\nSELECT 1;')).toEqual(['SELECT 1']);
    });

    it('refuses SQL it cannot split safely', () => {
      expect(() =>
        splitStatements('CREATE TRIGGER t BEGIN SELECT 1; END;'),
      ).toThrow(MigrationError);
    });
  });

  describe('the schema enforces what the old one did not', () => {
    beforeEach(() => migrate(db));

    it('refuses a negative amount', async () => {
      await expect(
        db.execute(
          `INSERT INTO distributions (
             baker_id, cycle, status, network, protocol_hash,
             pool, own_share, baker_fee, distributable, remainder, total_to_send,
             fee_numerator, fee_denominator, block_fees_included,
             payout_factor_numerator, payout_factor_denominator,
             delegator_count, created_at, updated_at
           ) VALUES ('tz1a', 1, 'planned', 'testnet', 'Pt', -1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, '', '')`,
        ),
      ).rejects.toThrow();
    });

    it('refuses a delegator line for a cycle that was never planned', async () => {
      await expect(
        db.execute(
          `INSERT INTO delegator_lines (
             baker_id, cycle, address, delegated_balance, gross, commission, net,
             carried_in, payable, transfer_cost, minimum, withheld, amount, carried_out,
             emptied, batch_index, op_hash, result
           ) VALUES ('tz1a', 999, 'tz1b', 0,0,0,0,0,0,0,0,0,0,0,0,NULL,NULL,'planned')`,
        ),
      ).rejects.toThrow();
    });

    it('refuses two rows for the same operation hash', async () => {
      await db.execute("INSERT INTO operation_hashes (op_hash, owner) VALUES ('op1', 'a')");
      await expect(
        db.execute("INSERT INTO operation_hashes (op_hash, owner) VALUES ('op1', 'b')"),
      ).rejects.toThrow();
    });
  });
});
