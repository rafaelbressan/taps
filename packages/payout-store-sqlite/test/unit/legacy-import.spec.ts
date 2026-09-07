import { LegacyParseError, parseH2Script } from '../../src/legacy/h2-script';
import { importLegacyExport, percentToRational } from '../../src/legacy/import';
import { sha256 } from '../../src/node';
import { migrate } from '../../src/migrate';
import { NodeSqliteDatabase } from '../../src/node-sqlite';
import { LEGACY_BAKER, LEGACY_EXPORT } from '../helpers/legacy-export';

describe('importing the database of the old TAPS', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = new NodeSqliteDatabase(':memory:');
    await migrate(db);
  });
  afterEach(() => db.close());

  it('reads every row of every table the export carries', () => {
    const rows = parseH2Script(LEGACY_EXPORT);
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.table, (counts.get(row.table) ?? 0) + 1);

    expect(counts.get('settings')).toBe(1);
    expect(counts.get('payments')).toBe(2);
    expect(counts.get('delegatorspayments')).toBe(3);
    expect(counts.get('delegatorsfee')).toBe(2);
    expect(counts.get('bondpool')).toBe(2);
    expect(counts.get('sessionlog')).toBe(1);
  });

  it('reads an escaped quote inside a name', () => {
    const pool = parseH2Script(LEGACY_EXPORT).filter((row) => row.table === 'bondpool');
    expect(pool[0]!.values.get('name')).toEqual({ kind: 'text', value: "O'Brien" });
    expect(pool[1]!.values.get('name')).toEqual({ kind: 'null' });
  });

  it('preserves the history and totals it exactly', async () => {
    const summary = await importLegacyExport(
      db,
      LEGACY_EXPORT,
      {
        source: 'taps-export.sql',
        sourceSha256: sha256(LEGACY_EXPORT),
        now: () => new Date('2026-09-06T12:00:00Z'),
      },
    );

    expect(summary.bakers).toEqual([LEGACY_BAKER]);
    expect(summary.payments).toBe(2);
    expect(summary.delegatorRows).toBe(3);
    expect(summary.cycles).toBe(2);
    // 120.000000 + 0.003970. The failed line is history, not money paid.
    expect(summary.totalPaid).toBe(120_003_970n);
    expect(summary.ignoredTables).toEqual(['sessionlog']);

    const lines = await db.query(
      'SELECT address, total, result FROM legacy_delegator_payments ORDER BY address',
    );
    expect(lines).toHaveLength(3);
    // The value the old converter turned into 3969.
    const burn = lines.find((row) => String(row.address).startsWith('tz1burn'))!;
    expect(burn.total).toBe(3_970n);
  });

  it('keeps a percentage as an exact rational', async () => {
    await importLegacyExport(db, LEGACY_EXPORT, { source: 'taps-export.sql', sourceSha256: sha256(LEGACY_EXPORT) });
    const fees = await db.query(
      'SELECT address, fee_numerator, fee_denominator FROM legacy_delegator_fees ORDER BY address',
    );
    expect(fees).toHaveLength(2);
    const custom = fees.find((row) => row.fee_numerator !== 0n)!;
    expect(custom.fee_numerator).toBe(525n);
    expect(custom.fee_denominator).toBe(10_000n);
  });

  it('does not carry the credentials of the old system', async () => {
    await importLegacyExport(db, LEGACY_EXPORT, { source: 'taps-export.sql', sourceSha256: sha256(LEGACY_EXPORT) });
    const tables = (
      await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((row) => String(row.name));
    for (const table of tables) {
      const columns = (await db.query(`PRAGMA table_info(${table})`)).map((row) =>
        String(row.name).toLowerCase(),
      );
      for (const forbidden of ['pass_hash', 'hash_salt', 'phrase', 'app_phrase', 'wallet_hash']) {
        expect(columns).not.toContain(forbidden);
      }
    }
    // And the secret text itself is nowhere in the file.
    const dump = await db.query(
      "SELECT COUNT(*) AS n FROM legacy_payments WHERE transaction_hash LIKE '%segredo%'",
    );
    expect(dump[0]!.n).toBe(0n);
  });

  it('records what was imported, so a restore can be checked against it', async () => {
    const summary = await importLegacyExport(db, LEGACY_EXPORT, { source: 'taps-export.sql', sourceSha256: sha256(LEGACY_EXPORT) });
    const rows = await db.query('SELECT * FROM legacy_import');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('taps-export.sql');
    expect(rows[0]!.source_sha256).toBe(summary.sourceSha256);
    expect(rows[0]!.total_paid).toBe(120_003_970n);
  });

  it('refuses to import the same file twice', async () => {
    await importLegacyExport(db, LEGACY_EXPORT, { source: 'taps-export.sql', sourceSha256: sha256(LEGACY_EXPORT) });
    await expect(
      importLegacyExport(db, LEGACY_EXPORT, { source: 'outro-nome.sql', sourceSha256: sha256(LEGACY_EXPORT) }),
    ).rejects.toThrow(/já foi importado/);
    expect((await db.query('SELECT COUNT(*) AS n FROM legacy_delegator_payments'))[0]!.n).toBe(3n);
  });

  it('refuses a file that is not an export', async () => {
    await expect(importLegacyExport(db, 'oi, tudo bem?', { source: 'errado.txt', sourceSha256: sha256('oi, tudo bem?') })).rejects.toBeInstanceOf(
      LegacyParseError,
    );
  });

  it('stops on a monetary column that is empty instead of importing zero', async () => {
    const broken = LEGACY_EXPORT.replace('120.000000', 'NULL');
    await expect(importLegacyExport(db, broken, { source: 'quebrado.sql', sourceSha256: sha256(broken) })).rejects.toThrow(
      /pagava zero em silêncio/,
    );
    expect((await db.query('SELECT COUNT(*) AS n FROM legacy_delegator_payments'))[0]!.n).toBe(0n);
  });

  describe('percentToRational', () => {
    it('is exact', () => {
      expect(percentToRational('5.25', 'fee')).toEqual({
        numerator: 525n,
        denominator: 10_000n,
      });
      expect(percentToRational('0.00', 'fee')).toEqual({
        numerator: 0n,
        denominator: 10_000n,
      });
      expect(percentToRational('100', 'fee')).toEqual({ numerator: 100n, denominator: 100n });
    });

    it('refuses more than the whole', () => {
      expect(() => percentToRational('101', 'fee')).toThrow(/mais de 100%/);
    });
  });
});
