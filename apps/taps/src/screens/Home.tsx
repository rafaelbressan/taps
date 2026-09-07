import { useEffect, useState } from 'react';
import type { SchedulerSnapshot } from '@tezos-suite/payout';
import type { Ready } from '../App';
import { describe } from '../App';
import type { Runtime } from '../lib/runtime';
import type { TapsSettings } from '../lib/settings';
import { statusText, whenText } from '../lib/format';
import { Address } from '../ui/Address';
import { Empty } from '../ui/Empty';
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
  // Sem a hora da leitura um valor velho é igual a um valor novo. O ciclo é
  // lido uma vez ao montar e não se atualiza sozinho — sem carimbo, a tela
  // afirma "1339" com a mesma confiança dez horas depois.
  const [readAt, setReadAt] = useState<Date | null>(null);
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
          setReadAt(new Date());
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

  // Uma instalação que ainda não terminou não é a mesma coisa que um sistema
  // que quebrou, e as duas não podem ter a mesma tela. Quando NADA está
  // configurado, listar os catorze campos que faltam diz tanto quanto não
  // dizer nada; o que serve é uma porta.
  if (blocked && !settings) {
    return (
      <>
        <h1 className="page__title">Início</h1>
        <div className="measure">
          <Empty
            title="O TAPS ainda não sabe por qual baker ele responde"
            next="A configuração leva alguns minutos e é feita uma vez. Nada é pago até o último campo estar preenchido — não há valor de fábrica em lugar nenhum."
          />
        </div>
        <div className="row" style={{ marginTop: 'var(--s-6)' }}>
          <button type="button" className="t-button" onClick={props.onGoToSettings}>
            Começar a configuração
          </button>
        </div>
      </>
    );
  }

  const verdict = readVerdict({ blocked, snapshot, chainError });

  return (
    <>
      <h1 className="page__title">Início</h1>
      <p className="page__lede">
        O TAPS roda nesta máquina. Não há servidor, não há login e não há porta aberta:
        quem paga é este programa, e quem assina é o <code>octez-signer</code> que você
        controla.
      </p>

      {/* A resposta antes das evidências. Sem esta linha, "está tudo em ordem?"
          só se responde lendo doze linhas em três cartões e concluindo sozinho. */}
      <p className={`verdict verdict--${verdict.tone}`} role="status">
        <strong className="verdict__what">{verdict.what}</strong>
        <span className="verdict__why">{verdict.why}</span>
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
          <h2 className="card__title">Agendador</h2>
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
          <h2 className="card__title">Cadeia</h2>
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
          {/* Sem a hora da leitura, um valor de dez horas atrás é igual a um
              valor de agora. O cartão inteiro é UMA leitura da cadeia, então o
              carimbo é do cartão, não de cada linha. */}
          {readAt && !chainError && (
            <p className="card__foot">
              <span className="t-stale">{whenText(readAt)}</span>
            </p>
          )}
          {chainError && (
            <Fault
              what="Não consegui ler o ciclo atual"
              where={settings?.tzktApiUrl ?? 'TzKT'}
              cost={`Sem isso o TAPS não sabe quais ciclos já podem ser pagos. ${chainError}`}
            />
          )}
        </section>

        <section className="t-card">
          <h2 className="card__title">Esta máquina</h2>
          <div className="pair pair--block">
            <span className="pair__key">Banco</span>
            <span className="pair__value">{ready.status.database_path}</span>
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

/**
 * O veredito, em uma frase.
 *
 * A ordem é deliberada: o que impede pagar vem antes do que está degradado, e
 * os dois vêm antes de "em ordem". A cor reforça, mas nunca carrega o
 * significado sozinha — o texto diz tudo, e diz em preto e branco.
 */
function readVerdict(state: {
  blocked: string | null;
  snapshot: SchedulerSnapshot | null;
  chainError: string | null;
}): { tone: 'ok' | 'attention' | 'stopped'; what: string; why: string } {
  if (state.blocked) {
    return {
      tone: 'stopped',
      what: 'Parado',
      why: 'Falta configuração. Nada foi pago e nada vai ser até isto ser resolvido.',
    };
  }
  if (state.snapshot?.status === 'waiting-for-human') {
    return {
      tone: 'stopped',
      what: 'Esperando você',
      why: 'A fila parou por conta própria e não segue sozinha. Nada foi pago.',
    };
  }
  if (state.chainError) {
    return {
      tone: 'attention',
      what: 'Sem leitura da cadeia',
      why: 'O agendador continua, mas não sabe qual é o ciclo atual. Nada é pago às cegas.',
    };
  }
  if (state.snapshot?.status === 'backing-off') {
    return {
      tone: 'attention',
      what: 'Tentando de novo',
      why: `A última passada falhou ${state.snapshot.consecutiveFailures}x seguidas. O TAPS espera e tenta outra vez.`,
    };
  }
  return {
    tone: 'ok',
    what: 'Em ordem',
    why: 'O agendador está rodando, a cadeia responde e a credencial está no lugar.',
  };
}
