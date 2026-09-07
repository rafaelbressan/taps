import { useEffect, useState } from 'react';
import type { SchedulerSnapshot } from '@tezos-suite/payout';
import type { Ready } from '../App';
import { describe } from '../App';
import type { Runtime } from '../lib/runtime';
import type { TapsSettings } from '../lib/settings';
import { statusText, whenText } from '../lib/format';
import { Address } from '../ui/Address';
import { Fault } from '../ui/Fault';

/**
 * A tela que responde "está tudo em ordem?".
 *
 * Quando **não** está, ela diz o que fazer em português. A configuração
 * ausente aparece aqui como instrução, e não como exceção de conexão: uma
 * instalação que ainda não terminou e um signer fora do ar são problemas
 * diferentes, e quem lê precisa saber qual dos dois é.
 */
export function Home(props: {
  ready: Ready;
  runtime: Runtime | null;
  settings: TapsSettings | null;
  blocked: string | null;
  onGoToSettings: () => void;
  onChanged: () => void;
}) {
  const { ready, runtime, settings, blocked } = props;
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot | null>(null);
  const [headCycle, setHeadCycle] = useState<number | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!runtime) {
      setSnapshot(null);
      return;
    }
    setSnapshot(runtime.scheduler.snapshot());
    let cancelled = false;
    (async () => {
      try {
        const cycle = await runtime.headCycle();
        if (!cancelled) {
          setHeadCycle(cycle);
          setChainError(null);
        }
      } catch (error) {
        // O ciclo não vira zero nem some da tela: ele fica marcado como não
        // lido, com o motivo. "Falte alto" também vale para a interface.
        if (!cancelled) setChainError(describe(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  async function runNow() {
    if (!runtime) return;
    setBusy(true);
    try {
      await runtime.scheduler.tick();
      setSnapshot(runtime.scheduler.snapshot());
      props.onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!runtime) return;
    await runtime.scheduler.resume(
      'operador do TAPS',
      'liberado na tela de início depois de conferir a fila',
    );
    setSnapshot(runtime.scheduler.snapshot());
    props.onChanged();
  }

  return (
    <>
      <h1 className="page__title">Início</h1>
      <p className="page__lede">
        O TAPS roda nesta máquina. Não há servidor, não há login e não há porta aberta:
        quem paga é este programa, e quem assina é o <code>octez-signer</code> que você
        controla.
      </p>

      {blocked && (
        <div className="stack" style={{ marginBottom: 'var(--s-6)' }}>
          <Fault
            what="O TAPS não vai pagar nada enquanto isto não for resolvido"
            where="configuração"
            cost={blocked}
          />
          <div>
            <button type="button" className="t-button" onClick={props.onGoToSettings}>
              Abrir configuração
            </button>
          </div>
        </div>
      )}

      <div className="grid">
        <section className="t-card">
          <h2 className="pair__key">Agendador</h2>
          <div className="pair">
            <span className="pair__key">Estado</span>
            <span className="pair__value">
              {snapshot ? statusText(snapshot.status) : 'não iniciado'}
            </span>
          </div>
          <div className="pair">
            <span className="pair__key">Última passada</span>
            <span className="pair__value">{whenText(snapshot?.lastRunFinishedAt ?? null)}</span>
          </div>
          <div className="pair">
            <span className="pair__key">Próxima tentativa</span>
            <span className="pair__value">{whenText(snapshot?.nextAttemptAt ?? null)}</span>
          </div>
          <div className="pair">
            <span className="pair__key">Falhas seguidas</span>
            <span className="pair__value">{snapshot?.consecutiveFailures ?? 0}</span>
          </div>
          {snapshot?.lastError && (
            <p className="t-field__error">{snapshot.lastError}</p>
          )}
          {snapshot?.status === 'waiting-for-human' && (
            <div className="stack" style={{ marginTop: 'var(--s-4)' }}>
              <p className="note">
                A fila parou porque há mais ciclos devidos que o limite configurado. Nada foi
                pago. Confira os ciclos e libere quando estiver certo do valor total.
              </p>
              <div>
                <button type="button" className="t-button" onClick={resume}>
                  Conferi, pode seguir
                </button>
              </div>
            </div>
          )}
          <div className="row" style={{ marginTop: 'var(--s-4)' }}>
            <button
              type="button"
              className="t-button t-button--quiet"
              disabled={!runtime || busy}
              onClick={runNow}
            >
              {busy ? 'rodando…' : 'Rodar agora'}
            </button>
          </div>
        </section>

        <section className="t-card">
          <h2 className="pair__key">Cadeia</h2>
          <div className="pair">
            <span className="pair__key">Rede</span>
            <span className="pair__value">
              {settings ? (
                <span
                  className={`t-network ${
                    settings.network === 'mainnet' ? 't-network--main' : 't-network--test'
                  }`}
                >
                  {settings.network}
                </span>
              ) : (
                '—'
              )}
            </span>
          </div>
          <div className="pair">
            <span className="pair__key">Ciclo atual</span>
            <span className="pair__value">
              {chainError ? (
                <span className="t-field__error">não lido</span>
              ) : headCycle === null ? (
                <span className="t-skeleton" />
              ) : (
                <span className="t-cycle">{headCycle}</span>
              )}
            </span>
          </div>
          <div className="pair">
            <span className="pair__key">Baker</span>
            <span className="pair__value">
              {settings ? <Address value={settings.bakerAddress} /> : '—'}
            </span>
          </div>
          {chainError && (
            <Fault
              what="Não consegui ler o ciclo atual"
              where={settings?.tzktApiUrl ?? 'TzKT'}
              cost={`Sem isso o TAPS não sabe quais ciclos já podem ser pagos. ${chainError}`}
            />
          )}
        </section>

        <section className="t-card">
          <h2 className="pair__key">Esta máquina</h2>
          <div className="pair">
            <span className="pair__key">Banco</span>
            <span className="pair__value" style={{ wordBreak: 'break-all' }}>
              {ready.status.database_path}
            </span>
          </div>
          <div className="pair">
            <span className="pair__key">Versão do schema</span>
            <span className="pair__value">{ready.schemaVersion}</span>
          </div>
          <div className="pair">
            <span className="pair__key">Credencial do signer</span>
            <span className="pair__value">
              {ready.status.signer_credential_present ? 'no cofre do sistema' : 'ausente'}
            </span>
          </div>
          <p className="note" style={{ marginTop: 'var(--s-3)' }}>
            A chave que paga fica no host do <code>octez-signer</code> e nunca chega aqui.
          </p>
        </section>
      </div>
    </>
  );
}
