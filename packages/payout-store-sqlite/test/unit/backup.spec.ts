import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupError, inspectBackup, restoreBackup } from '../../src/backup';
import { backupInto } from '../../src/backup-core';
import { sha256 } from '../../src/node';
import { importLegacyExport } from '../../src/legacy/import';
import { migrate } from '../../src/migrate';
import { openPayoutDatabase } from '../../src/open';
import { BAKER, newDistribution } from '../helpers/fixtures';
import { LEGACY_EXPORT } from '../helpers/legacy-export';
import { NodeSqliteDatabase } from '../../src/node-sqlite';

describe('backup and restore', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'taps-backup-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const live = () => join(directory, 'taps.db');
  const copy = (name = 'backup.db') => join(directory, name);

  it('takes a consistent copy while the app is open, and restores it', async () => {
    const opened = await openPayoutDatabase(live());
    await opened.store.createDistribution(newDistribution(1400));
    await importLegacyExport(opened.db, LEGACY_EXPORT, {
      source: 'taps-export.sql',
      sourceSha256: sha256(LEGACY_EXPORT),
    });

    await backupInto(opened.db, copy());

    // The app keeps running and the database moves on after the backup.
    await opened.store.createDistribution(newDistribution(1401));
    await opened.db.close();

    const inspection = await inspectBackup(copy());
    expect(inspection.distributions).toBe(1);
    expect(inspection.legacyRows).toBe(3);
    expect(inspection.bakers).toEqual([BAKER]);

    const result = await restoreBackup(copy(), live(), () => new Date('2026-09-06T12:00:00Z'));
    expect(result.replacedCopiedTo).toContain('substituido-2026-09-06');

    const reopened = await openPayoutDatabase(live());
    expect(await reopened.store.getDistribution(BAKER, 1400)).toBeDefined();
    // Cycle 1401 was written after the backup and is not in it. Losing it is
    // the whole meaning of restoring, and it has to be visible rather than
    // half-present.
    expect(await reopened.store.getDistribution(BAKER, 1401)).toBeUndefined();
    await reopened.db.close();
  });

  it('never overwrites an existing backup file', async () => {
    const opened = await openPayoutDatabase(live());
    await backupInto(opened.db, copy());
    await expect(backupInto(opened.db, copy())).rejects.toBeInstanceOf(BackupError);
    await opened.db.close();
  });

  it('keeps the database it replaced, so a wrong choice is undoable', async () => {
    const first = await openPayoutDatabase(live());
    await first.store.createDistribution(newDistribution(1500));
    await backupInto(first.db, copy());
    await first.store.createDistribution(newDistribution(1501));
    await first.db.close();

    const result = await restoreBackup(copy(), live());

    const previous = new NodeSqliteDatabase(result.replacedCopiedTo);
    const rows = await previous.query('SELECT cycle FROM distributions ORDER BY cycle');
    expect(rows.map((row) => Number(row.cycle))).toEqual([1500, 1501]);
    await previous.close();
  });

  it('refuses a file that is not a database', async () => {
    writeFileSync(copy('lixo.db'), 'isto não é um banco');
    await expect(inspectBackup(copy('lixo.db'))).rejects.toBeInstanceOf(BackupError);
  });

  it('refuses a SQLite file that is not a TAPS backup', async () => {
    const other = new NodeSqliteDatabase(copy('outro.db'));
    await other.execute('CREATE TABLE qualquer (a INTEGER)');
    await other.close();
    await expect(inspectBackup(copy('outro.db'))).rejects.toThrow(
      /não é um backup deste aplicativo/,
    );
  });

  it('refuses a backup written by a newer version', async () => {
    const future = new NodeSqliteDatabase(copy('futuro.db'));
    await migrate(future);
    await future.execute(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'futuro', '2030-01-01T00:00:00Z')",
    );
    await future.close();
    await expect(inspectBackup(copy('futuro.db'))).rejects.toThrow(/atualize o TAPS/i);
  });

  it('leaves the live database untouched when the candidate is refused', async () => {
    const opened = await openPayoutDatabase(live());
    await opened.store.createDistribution(newDistribution(1600));
    await opened.db.close();

    writeFileSync(copy('lixo.db'), 'isto não é um banco');
    await expect(restoreBackup(copy('lixo.db'), live())).rejects.toThrow();

    const reopened = await openPayoutDatabase(live());
    expect(await reopened.store.getDistribution(BAKER, 1600)).toBeDefined();
    await reopened.db.close();
  });
});
