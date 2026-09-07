import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pickFile } from '../lib/pick';
import { importLegacyExport, type ImportSummary } from '@tezos-suite/payout-store-sqlite';
import type { Ready } from '../App';
import { describe } from '../App';
import { Amount } from '../ui/Amount';
import { Fault } from '../ui/Fault';

/**
 * Trazer o histórico da versão antiga.
 *
 * O TAPS antigo guarda os dados num H2 embutido, cujo formato de arquivo não
 * tem leitor fora da JVM. Em vez de exigir Java na máquina do baker, a
 * migração pede o **arquivo exportado** — um comando que o console do H2 já
 * oferece — e lê o texto. O baker fica com um arquivo que ele consegue abrir e
 * guardar, o que já é melhor que um banco binário.
 *
 * O que atravessa: quem foi pago, quanto, em qual ciclo, sob qual hash, e as
 * comissões individuais. O que não atravessa: senha, hash de senha, sal, e a
 * frase de recuperação cifrada com sal literal — carregar isso seria carregar
 * um modelo de custódia quebrado para um produto que decidiu não guardar chave
 * nenhuma.
 */
export function Migration({ ready, onChanged }: { ready: Ready; onChanged: () => void }) {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [previous, setPrevious] = useState<
    { source: string; importedAt: string; totalPaid: bigint }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const rows = await ready.db.query(
        'SELECT source, imported_at, total_paid FROM legacy_import ORDER BY id DESC',
      );
      setPrevious(
        rows.map((row) => ({
          source: String(row.source),
          importedAt: String(row.imported_at),
          totalPaid: row.total_paid as bigint,
        })),
      );
    })().catch((caught) => setError(describe(caught)));
  }, [ready, summary]);

  async function importFile() {
    setError(null);
    setSummary(null);
    const chosen = await pickFile(
      'legacy-export',
      'Arquivo exportado do TAPS antigo (taps-export.sql)',
    );
    if (!chosen) return;

    setBusy(true);
    try {
      const script = await invoke<string>('read_legacy_export', { token: chosen.token });
      // O digest identifica o arquivo, e é o que impede importar o mesmo
      // histórico duas vezes com outro nome.
      const digest = await sha256(script);
      const result = await importLegacyExport(ready.db, script, {
        source: chosen.name,
        sourceSha256: digest,
      });
      setSummary(result);
      onChanged();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page__title">Migração</h1>
      <p className="page__lede">
        Se você já rodava o TAPS antigo, o histórico de pagamentos vem junto. Nenhum valor é
        recalculado: as casas decimais do banco antigo entram exatamente como estavam.
      </p>

      <section className="t-card" style={{ marginBottom: 'var(--s-6)' }}>
        <h2 className="pair__key">Como exportar do TAPS antigo</h2>
        <ol className="note">
          <li>Pare o Lucee: <code>sudo /opt/lucee/lucee_ctl stop</code>.</li>
          <li>Abra o console do H2 e conecte em <code>jdbc:h2:[pasta]/database/tapsDB;MODE=MySQL</code>.</li>
          <li>
            Rode <code>SCRIPT TO 'taps-export.sql'</code>.
          </li>
          <li>Traga o arquivo para esta máquina e escolha-o abaixo.</li>
        </ol>
        <div className="row" style={{ marginTop: 'var(--s-4)' }}>
          <button type="button" className="t-button" disabled={busy} onClick={importFile}>
            {busy ? 'importando…' : 'Escolher o arquivo exportado'}
          </button>
        </div>
      </section>

      {error && (
        <Fault
          what="Não importei nada"
          where="arquivo exportado"
          cost={`O banco ficou exatamente como estava. ${error}`}
        />
      )}

      {summary && (
        <section className="t-card">
          <h2 className="pair__key">Importado</h2>
          <div className="pair">
            <span className="pair__key">Bakers</span>
            <span className="pair__value">{summary.bakers.join(', ')}</span>
          </div>
          <div className="pair">
            <span className="pair__key">Ciclos</span>
            <span className="pair__value">{summary.cycles}</span>
          </div>
          <div className="pair">
            <span className="pair__key">Linhas de delegador</span>
            <span className="pair__value">{summary.delegatorRows}</span>
          </div>
          <div className="pair">
            <span className="pair__key">Comissões individuais</span>
            <span className="pair__value">{summary.customRates}</span>
          </div>
          <div className="pair">
            <span className="pair__key">Total já pago</span>
            <span className="pair__value">
              <Amount mutez={summary.totalPaid} />
            </span>
          </div>
          {summary.ignoredTables.length > 0 && (
            <p className="note" style={{ marginTop: 'var(--s-3)' }}>
              Tabelas do arquivo que não vieram: {summary.ignoredTables.join(', ')}. Elas
              guardavam configuração de um servidor que não existe mais, ou credenciais que
              este produto decidiu não ter.
            </p>
          )}
        </section>
      )}

      {previous.length > 0 && (
        <section className="t-card" style={{ marginTop: 'var(--s-6)' }}>
          <h2 className="pair__key">Importações anteriores</h2>
          {previous.map((entry) => (
            <div className="pair" key={`${entry.source}-${entry.importedAt}`}>
              <span className="pair__key">{entry.importedAt}</span>
              <span className="pair__value">
                <Amount mutez={entry.totalPaid} />
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/**
 * SHA-256 pelo Web Crypto.
 *
 * O importador recebe o digest de fora justamente para poder rodar aqui: a
 * webview não tem `node:crypto`, e o mesmo módulo precisa servir os testes no
 * Node e o aplicativo.
 */
async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
