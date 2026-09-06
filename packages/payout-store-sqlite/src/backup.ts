import { copyFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { NodeSqliteDatabase } from './node-sqlite';
import { readAppliedMigrations } from './migrate';
import { intOf, textOf } from './codec';
import { BackupError, INTEGRITY_CHECK, judgeBackup, replacedName } from './backup-core';
import type { SqlDatabase } from './db';

/**
 * A metade da restauração que precisa de sistema de arquivos.
 *
 * `backupInto` mora em `backup-core` porque roda igual no Node e na webview do
 * aplicativo. Conferir um candidato e trocar o arquivo, não: são operações de
 * disco, e no desktop elas são do lado Rust. As duas implementações fazem a
 * mesma coisa, na mesma ordem, e o teste desta aqui é o que descreve a ordem.
 *
 * A propriedade que importa mais que a conveniência: **uma restauração confere
 * antes de sobrescrever.** Um arquivo que não é banco, que está corrompido ou
 * que foi escrito por uma versão mais nova é recusado com o motivo, e o banco
 * atual fica exatamente como estava.
 */

export interface BackupInspection {
  readonly path: string;
  readonly bytes: number;
  readonly schemaVersion: number;
  readonly distributions: number;
  readonly delegatorLines: number;
  readonly legacyRows: number;
  readonly bakers: readonly string[];
}

/** Abre um candidato e responde se ele pode ser restaurado. Nunca toca no banco vivo. */
export async function inspectBackup(path: string): Promise<BackupInspection> {
  if (!existsSync(path)) {
    throw new BackupError(`não achei o arquivo ${path}`);
  }
  const bytes = statSync(path).size;

  let db: NodeSqliteDatabase;
  try {
    db = new NodeSqliteDatabase(path);
  } catch (cause) {
    throw new BackupError(
      `${path} não abre como banco do TAPS (${(cause as Error).message}) — ` +
        'talvez seja outro arquivo, ou tenha sido copiado pela metade',
    );
  }

  try {
    const integrity = await db.query(INTEGRITY_CHECK);
    const verdict = integrity[0] ? textOf(integrity[0], 'integrity_check') : 'sem resposta';
    const applied = await readAppliedMigrations(db);
    const schemaVersion = judgeBackup({
      path,
      integrity: verdict,
      appliedVersions: applied.map((entry) => entry.version),
    });

    return {
      path,
      bytes,
      schemaVersion,
      distributions: await count(db, 'distributions'),
      delegatorLines: await count(db, 'delegator_lines'),
      legacyRows: schemaVersion >= 2 ? await count(db, 'legacy_delegator_payments') : 0,
      bakers: (
        await db.query('SELECT DISTINCT baker_id FROM distributions ORDER BY baker_id')
      ).map((row) => textOf(row, 'baker_id')),
    };
  } finally {
    await db.close();
  }
}

export interface RestoreResult {
  readonly inspection: BackupInspection;
  /** Onde foi parar o banco substituído. Nada é apagado. */
  readonly replacedCopiedTo: string;
}

/**
 * Põe `backupPath` no lugar de `targetPath`.
 *
 * O banco substituído é renomeado, nunca removido: a restauração é o momento em
 * que um baker tem mais chance de escolher o arquivo errado, e a saída desse
 * erro precisa existir antes do erro.
 *
 * O chamador precisa ter fechado o banco vivo. Não há como esta função
 * conferir isso, e é por isso que no aplicativo a mesma sequência é feita do
 * lado Rust, que fecha a conexão como parte da ação.
 */
export async function restoreBackup(
  backupPath: string,
  targetPath: string,
  now: () => Date = () => new Date(),
): Promise<RestoreResult> {
  const inspection = await inspectBackup(backupPath);

  const replaced = replacedName(targetPath, now());
  if (existsSync(targetPath)) {
    renameSync(targetPath, replaced);
    // Um WAL deixado para trás pertence ao banco que acabou de sair de cena;
    // deixá-lo ao lado do arquivo restaurado deixaria o SQLite reproduzi-lo por
    // cima do backup.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${targetPath}${suffix}`)) {
        renameSync(`${targetPath}${suffix}`, `${replaced}${suffix}`);
      }
    }
  }
  copyFileSync(backupPath, targetPath);

  return { inspection, replacedCopiedTo: replaced };
}

async function count(db: SqlDatabase, table: string): Promise<number> {
  const rows = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return rows[0] ? intOf(rows[0], 'n') : 0;
}

export { BackupError, judgeBackup };
