import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pickFile, pickSavePath } from '../lib/pick';
import {
  BackupError,
  INTEGRITY_CHECK,
  SCHEMA_VERSION_QUERY,
  judgeBackup,
} from '@tezos-suite/payout-store-sqlite';
import type { Ready } from '../App';
import { describe } from '../App';
import { queryOtherDatabase } from '../lib/tauri-sql';
import { Fault } from '../ui/Fault';

/**
 * Backup e restauração, para quem não abre terminal.
 *
 * O que isto substitui, palavra por palavra, é a instrução de atualização do
 * TAPS antigo: "(Always!) Write down in a piece of paper your Taps Native
 * Wallet mnemonic words and passphrase", seguida de `git fetch --all` e
 * `git reset --hard origin/master`. Um procedimento de backup que começa num
 * papel e termina num comando destrutivo não é um procedimento de backup.
 *
 * Duas propriedades valem mais que a conveniência, e as duas estão aqui:
 *
 * 1. A cópia sai com o aplicativo aberto e sai **inteira** (`VACUUM INTO`).
 * 2. A restauração **confere antes** de sobrescrever, e o banco substituído é
 *    renomeado, nunca apagado.
 */
export function Backup({ ready, onChanged }: { ready: Ready; onChanged: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function takeBackup() {
    setError(null);
    setMessage(null);
    const suggested = `taps-${new Date().toISOString().slice(0, 10)}.db`;
    const chosen = await pickSavePath('backup-destination', 'Onde salvar o backup', suggested);
    if (!chosen) return;

    setBusy(true);
    try {
      // `VACUUM INTO` do lado do Rust, contra o caminho que o diálogo guardou.
      // A tela não sabe onde o arquivo fica, e por isso não pode escolher.
      const summary = await invoke<{ name: string; bytes: number }>('backup_into', {
        token: chosen.token,
      });
      setMessage(
        `Backup salvo como ${summary.name} (${Math.round(summary.bytes / 1024)} kB). ` +
          'Guarde-o fora deste computador.',
      );
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setError(null);
    setMessage(null);
    const chosen = await pickFile('backup-to-restore', 'Qual backup restaurar');
    if (!chosen) return;

    setBusy(true);
    try {
      // Confere ANTES de trocar. As mesmas duas consultas do pacote, e o mesmo
      // julgamento: um arquivo corrompido, que não é do TAPS, ou escrito por
      // uma versão mais nova é recusado com o motivo, e o banco atual fica como
      // estava. Conferir não gasta o token — restaurar vem logo depois.
      const integrity = await queryOtherDatabase(chosen.token, INTEGRITY_CHECK);
      const verdict = integrity[0] ? String(integrity[0].integrity_check) : 'sem resposta';
      const applied = await queryOtherDatabase(chosen.token, SCHEMA_VERSION_QUERY).catch(
        () => [],
      );
      const version = judgeBackup({
        path: chosen.name,
        integrity: verdict,
        appliedVersions: applied.map((row) => Number(row.version)),
      });

      const rows = await queryOtherDatabase(
        chosen.token,
        'SELECT COUNT(*) AS n FROM distributions',
      );
      const cycles = rows[0] ? Number(rows[0].n) : 0;

      const confirmed = window.confirm(
        `${chosen.name} tem ${cycles} ciclo(s) e está na versão de schema ${version}.\n\n` +
          'Restaurar substitui o banco atual. O banco de agora não é apagado: ele é ' +
          'renomeado ao lado, e você pode voltar atrás.\n\nRestaurar?',
      );
      if (!confirmed) return;

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const result = await invoke<{ replaced_copied_to: string }>('restore_backup', {
        token: chosen.token,
        stamp,
      });
      setMessage(
        `Restaurado. O banco anterior ficou em ${result.replaced_copied_to} — ` +
          'apague só quando tiver certeza.',
      );
      onChanged();
    } catch (caught) {
      setError(
        caught instanceof BackupError
          ? caught.message
          : `Não restaurei nada. ${describe(caught)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page__title">Backup</h1>
      <p className="page__lede">
        Um arquivo, um botão. Guarde a cópia fora deste computador — um backup no mesmo disco
        não sobrevive ao que costuma acontecer com discos.
      </p>

      {error && <Fault what="Não deu certo" where="backup" cost={error} />}
      {message && <p className="note">{message}</p>}

      <div className="grid" style={{ marginTop: 'var(--s-6)' }}>
        <section className="t-card">
          <h2 className="pair__key">Salvar uma cópia</h2>
          <p className="note">
            Pode fazer com o TAPS aberto. A cópia sai inteira, mesmo no meio de um ciclo.
          </p>
          <div className="row" style={{ marginTop: 'var(--s-4)' }}>
            <button type="button" className="t-button" disabled={busy} onClick={takeBackup}>
              Salvar backup
            </button>
          </div>
        </section>

        <section className="t-card">
          <h2 className="pair__key">Restaurar de uma cópia</h2>
          <p className="note">
            O arquivo é conferido antes de qualquer coisa ser trocada. O banco de agora é
            renomeado ao lado, nunca apagado.
          </p>
          <div className="row" style={{ marginTop: 'var(--s-4)' }}>
            <button
              type="button"
              className="t-button t-button--quiet"
              disabled={busy}
              onClick={restore}
            >
              Restaurar backup
            </button>
          </div>
        </section>

        <section className="t-card">
          <h2 className="pair__key">O que NÃO está no backup</h2>
          <p className="note">
            A credencial de cliente do <code>octez-signer</code> fica no cofre do sistema
            operacional, não no banco. Restaurar noutra máquina exige cadastrá-la de novo — e
            isso é de propósito: um backup que carrega credencial é uma credencial a mais
            circulando em pen drive.
          </p>
          <p className="note">
            A chave que paga nunca esteve aqui. Ela vive no host do <code>octez-signer</code>.
          </p>
        </section>
      </div>
    </>
  );
}
