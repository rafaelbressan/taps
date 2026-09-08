import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pickFile, pickSavePath } from '../lib/pick';
import {
  BackupError,
  INTEGRITY_CHECK,
  SCHEMA_VERSION_QUERY,
  judgeBackup,
  judgeUnreadable,
  type SqlRow,
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
 * 2. A restauração **confere antes** de sobrescrever, **pergunta** antes de
 *    trocar, e o banco substituído é renomeado, nunca apagado.
 */

/** O que se sabe de um banco olhando só a tabela de ciclos. */
interface CycleSummary {
  readonly cycles: number;
  /** `null` quando o banco não tem ciclo nenhum — não é zero. */
  readonly newestCycle: number | null;
}

/** Um candidato conferido, esperando a resposta de quem vai perder o banco atual. */
interface Candidate {
  readonly token: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly backup: CycleSummary;
  readonly current: CycleSummary;
}

const CYCLE_SUMMARY_QUERY = 'SELECT COUNT(*) AS n, MAX(cycle) AS newest FROM distributions';

/**
 * Lê a contagem sem inventar valor.
 *
 * `MAX(cycle)` de tabela vazia volta NULL, e `Number(null)` é 0 — que é o
 * mesmo `|| 0` que fez o sistema antigo pagar zero em silêncio. Aqui a
 * ausência continua ausência, e a tela mostra travessão.
 */
function readCycleSummary(rows: readonly SqlRow[], what: string): CycleSummary {
  const row = rows[0];
  if (!row || row.n === null || row.n === undefined) {
    throw new BackupError(`não consegui contar os ciclos ${what} — não troquei nada`);
  }
  return {
    cycles: Number(row.n),
    newestCycle: row.newest === null || row.newest === undefined ? null : Number(row.newest),
  };
}

function cycleText(value: number | null): string {
  return value === null ? '—' : String(value);
}

export function Backup({ ready, onChanged }: { ready: Ready; onChanged: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);

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

  /**
   * Primeiro passo: escolher, conferir e **parar**.
   *
   * Escolher o arquivo no diálogo não troca banco nenhum. Esta função nunca
   * chama `restore_backup`; ela só monta a comparação que a próxima tela
   * mostra. Quem troca é `confirmRestore`, e só depois de um clique.
   */
  async function inspectCandidate() {
    setError(null);
    setMessage(null);
    setCandidate(null);
    const chosen = await pickFile('backup-to-restore', 'Qual backup restaurar');
    if (!chosen) return;

    setBusy(true);
    try {
      // Confere ANTES de qualquer coisa. As mesmas duas consultas do pacote, e
      // o mesmo julgamento: um arquivo corrompido, que não é do TAPS, ou
      // escrito por uma versão mais nova é recusado com o motivo, e o banco
      // atual fica como estava. Conferir não gasta o token — restaurar vem
      // depois e usa o mesmo.
      // Um `.txt` nem chega a abrir: o SQLite recusa antes, e a mensagem dele
      // é em inglês. `judgeUnreadable` diz a mesma coisa em português.
      const integrity = await queryOtherDatabase(chosen.token, INTEGRITY_CHECK).catch(
        (cause: unknown) => {
          throw judgeUnreadable(chosen.name, cause);
        },
      );
      const verdict = integrity[0] ? String(integrity[0].integrity_check) : 'sem resposta';
      const applied = await queryOtherDatabase(chosen.token, SCHEMA_VERSION_QUERY).catch(
        () => [],
      );
      const schemaVersion = judgeBackup({
        path: chosen.name,
        integrity: verdict,
        appliedVersions: applied.map((row) => Number(row.version)),
      });

      const backup = readCycleSummary(
        await queryOtherDatabase(chosen.token, CYCLE_SUMMARY_QUERY),
        'do backup',
      );
      // O banco de agora entra na comparação porque é ele que se perde. Saber
      // que o backup tem 4 ciclos não diz nada; saber que o seu banco tem 12 é
      // a frase que evita o estrago.
      const current = readCycleSummary(
        await ready.db.query(CYCLE_SUMMARY_QUERY),
        'do banco atual',
      );

      setCandidate({ token: chosen.token, name: chosen.name, schemaVersion, backup, current });
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

  /** Segundo passo, e o único que troca banco. */
  async function confirmRestore(chosen: Candidate) {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const result = await invoke<{ replaced_copied_to: string }>('restore_backup', {
        token: chosen.token,
        stamp,
      });
      setCandidate(null);
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

  function cancelRestore() {
    setCandidate(null);
    setMessage('Cancelado. O banco de agora continua sendo o banco de agora.');
  }

  const losing = candidate
    ? candidate.current.cycles - candidate.backup.cycles
    : 0;

  return (
    <>
      <h1 className="page__title">Backup</h1>
      <p className="page__lede">
        Um arquivo, um botão. Guarde a cópia fora deste computador — um backup no mesmo disco
        não sobrevive ao que costuma acontecer com discos.
      </p>

      {error && <Fault what="Não deu certo" where="backup" cost={error} />}
      {message && <p className="note">{message}</p>}

      {candidate && (
        <section
          className="confirm"
          role="alertdialog"
          aria-labelledby="restaurar-confirmacao"
          style={{ marginTop: 'var(--s-6)' }}
        >
          {/* `alertdialog`, e não `group`: isto interrompe uma jornada para
              perguntar sobre uma troca que não se desfaz sozinha. O leitor de
              tela precisa ouvir isso, e o cartão precisa parecer isso. */}
          <h2 id="restaurar-confirmacao" className="confirm__what">
            Restaurar a partir de {candidate.name}?
          </h2>
          <p className="note">
            O arquivo passou na conferência (versão de schema {candidate.schemaVersion}).
            Nada foi trocado ainda.
          </p>

          <table className="table" style={{ marginTop: 'var(--s-4)' }}>
            <thead>
              <tr>
                <th scope="col">&nbsp;</th>
                <th scope="col" className="num">
                  Este backup
                </th>
                <th scope="col" className="num">
                  Seu banco agora
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Ciclos</th>
                <td className="num">{candidate.backup.cycles}</td>
                <td className="num">{candidate.current.cycles}</td>
              </tr>
              <tr>
                <th scope="row">Ciclo mais recente</th>
                <td className="num">{cycleText(candidate.backup.newestCycle)}</td>
                <td className="num">{cycleText(candidate.current.newestCycle)}</td>
              </tr>
            </tbody>
          </table>

          {losing > 0 && (
            <p className="note" role="alert" style={{ marginTop: 'var(--s-4)' }}>
              O seu banco tem {losing} ciclo(s) que este backup não tem. Restaurar tira esse
              registro do banco ativo — confira se é mesmo o arquivo certo.
            </p>
          )}

          <p className="note" style={{ marginTop: 'var(--s-4)' }}>
            Restaurar substitui o banco atual. O banco de agora não é apagado: ele é renomeado
            ao lado, com data e hora no nome, e você pode voltar atrás.
          </p>

          <div className="row" style={{ marginTop: 'var(--s-4)' }}>
            <button
              type="button"
              className="t-button"
              disabled={busy}
              onClick={() => void confirmRestore(candidate)}
            >
              Restaurar
            </button>
            <button
              type="button"
              className="t-button t-button--quiet"
              disabled={busy}
              onClick={cancelRestore}
            >
              Cancelar
            </button>
          </div>
        </section>
      )}

      <div className="grid" style={{ marginTop: 'var(--s-6)' }}>
        <section className="t-card">
          <h2 className="card__title">Salvar uma cópia</h2>
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
          <h2 className="card__title">Restaurar de uma cópia</h2>
          <p className="note">
            O arquivo é conferido antes de qualquer coisa ser trocada, e o TAPS mostra quantos
            ciclos ele tem e pergunta antes de trocar. O banco de agora é renomeado ao lado,
            nunca apagado.
          </p>
          <div className="row" style={{ marginTop: 'var(--s-4)' }}>
            <button
              type="button"
              className="t-button t-button--quiet"
              disabled={busy || candidate !== null}
              onClick={inspectCandidate}
            >
              Restaurar backup
            </button>
          </div>
        </section>

        <section className="t-card">
          <h2 className="card__title">O que NÃO está no backup</h2>
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
