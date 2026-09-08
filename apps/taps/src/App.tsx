import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ConfigurationError } from '@tezos-suite/chain';
import type { SqlitePayoutStore } from '@tezos-suite/payout-store-sqlite';
import { Backup } from './screens/Backup';
import { Cycles } from './screens/Cycles';
import { Home } from './screens/Home';
import { Migration } from './screens/Migration';
import { Settings } from './screens/Settings';
import { Trail } from './screens/Trail';
import { Fault } from './ui/Fault';
import { buildRuntime, openDatabase, type Runtime } from './lib/runtime';
import {
  missingSettings,
  parseSettings,
  readRawSettings,
  type TapsSettings,
} from './lib/settings';
import type { TauriSqlDatabase } from './lib/tauri-sql';

/**
 * A janela do TAPS.
 *
 * O que ela garante, antes de qualquer outra coisa: **o aplicativo não opera
 * sem signer configurado**, e quando falta configuração ele diz em português o
 * que fazer, em vez de mostrar uma exceção de conexão. A configuração ausente
 * não é um erro de rede — é uma instalação que ainda não terminou, e as duas
 * coisas pedem respostas diferentes de quem lê.
 */

type Tab = 'inicio' | 'ciclos' | 'configuracao' | 'backup' | 'migracao' | 'auditoria';

const TABS: { readonly id: Tab; readonly label: string }[] = [
  { id: 'inicio', label: 'Início' },
  { id: 'ciclos', label: 'Ciclos' },
  { id: 'auditoria', label: 'Trilha' },
  { id: 'backup', label: 'Backup' },
  { id: 'migracao', label: 'Migração' },
  { id: 'configuracao', label: 'Configuração' },
];

interface AppStatus {
  readonly database_path: string;
  readonly signer_credential_present: boolean;
  /** O `edpk` da credencial guardada. Público — a chave privada não sai do Rust. */
  readonly signer_credential_public_key: string | null;
  /** Preenchido quando o cofre do sistema não respondeu. */
  readonly signer_vault_error: string | null;
  readonly signer_tls_ca_present: boolean;
  readonly platform: string;
  readonly version: string;
}

export interface Ready {
  readonly db: TauriSqlDatabase;
  readonly store: SqlitePayoutStore;
  readonly schemaVersion: number;
  readonly status: AppStatus;
}

/**
 * O agendador acorda a cada minuto, e o motor decide se já é hora.
 *
 * O intervalo do TAPS é medido em ciclo Tezos, não em minuto: um ciclo leva
 * cerca de um dia em mainnet. Dez minutos entre passadas é curto o bastante
 * para nunca atrasar um pagamento e longo o bastante para não conversar com a
 * TzKT à toa.
 */
const SCHEDULER_POLICY = {
  intervalMs: 10 * 60_000,
  backoffMs: 60_000,
  maxBackoffMs: 30 * 60_000,
};

export function App() {
  const [tab, setTab] = useState<Tab>('inicio');
  const [ready, setReady] = useState<Ready | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [settings, setSettings] = useState<TapsSettings | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // A assinatura da configuração com que o motor atual foi montado.
  //
  // Sem isto o motor era remontado a cada `refresh`, e como o tique chama
  // `refresh` no fim de toda passada, o agendador nascia de novo a cada
  // passada: estado "parado", "última passada —" e "falhas seguidas 0" para
  // sempre, enquanto a Trilha enchia de tentativas. O que a tela mostrava não
  // era um agendador parado, era um agendador recém-nascido.
  const builtFrom = useRef<string | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);

  // O efeito é assíncrono e enxergaria um `runtime` velho pela closure; o ref
  // acompanha o estado para que a comparação acima olhe o motor de agora.
  const holdRuntime = useCallback((next: Runtime | null, signature: string | null) => {
    runtimeRef.current = next;
    builtFrom.current = signature;
    setRuntime(next);
  }, []);

  // Abrir o banco e aplicar as migrations é a primeira coisa que acontece, e
  // acontece sempre. A versão que este substitui não tinha migration nenhuma:
  // o sistema subia e falhava na primeira consulta.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await invoke<AppStatus>('app_status');
        const opened = await openDatabase();
        if (!cancelled) setReady({ ...opened, status });
      } catch (error) {
        if (!cancelled) setFatal(describe(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // O banco abre uma vez; `app_status` não pode. Ele carrega o estado da
  // credencial, e esse estado muda no meio da sessão: importar a credencial
  // e voltar para o Início mostrava "ausente" — com o bloqueio de volta —
  // até fechar e reabrir o aplicativo, porque o efeito acima só roda na
  // montagem. Quem importa, esquece ou salva já chama `refresh`; faltava
  // alguém reler o status quando ele chama.
  useEffect(() => {
    if (revision === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await invoke<AppStatus>('app_status');
        if (!cancelled) {
          setReady((current) => (current ? { ...current, status } : current));
        }
      } catch (error) {
        if (!cancelled) setFatal(describe(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  // Montar o motor depende da configuração estar completa. Enquanto não
  // estiver, `blocked` carrega a frase que a tela mostra — e nenhum tique roda.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await readRawSettings(ready.db);
        const missing = missingSettings(raw);
        if (missing.length > 0) {
          if (!cancelled) {
            setSettings(null);
            holdRuntime(null, null);
            setBlocked(
              `O TAPS ainda não está configurado. Falta preencher: ${missing
                .map((entry) => entry.label)
                .join(', ')}. Abra Configuração.`,
            );
          }
          return;
        }

        const parsed = parseSettings(raw);
        // Cofre fora do ar não é credencial faltando. Mandar o baker importar
        // de novo a credencial que já está lá é o pior conselho possível.
        if (ready.status.signer_vault_error) {
          if (!cancelled) {
            setSettings(parsed);
            holdRuntime(null, null);
            setBlocked(
              'O cofre de credenciais desta sessão não respondeu, então o TAPS não consegue ' +
                'ler a credencial do signer — nem saber se ela está lá. Não é a credencial ' +
                `que está faltando. ${ready.status.signer_vault_error}`,
            );
          }
          return;
        }
        if (!ready.status.signer_credential_present) {
          if (!cancelled) {
            setSettings(parsed);
            holdRuntime(null, null);
            setBlocked(
              'Falta a credencial de cliente do octez-signer. É com ela que este computador ' +
                'prova ao signer quem está pedindo, e sem ela o signer recusa o pedido. Abra ' +
                'Configuração e escolha o arquivo da chave que você autorizou no signer.',
            );
          }
          return;
        }

        // Remontar só quando a configuração muda de verdade. `bigint` não
        // sobrevive ao `JSON.stringify` sozinho, daí o replacer.
        const signature = JSON.stringify(parsed, (_key, value) =>
          typeof value === 'bigint' ? `${value}n` : value,
        );
        if (builtFrom.current === signature && runtimeRef.current) {
          if (!cancelled) {
            setSettings(parsed);
            setBlocked(null);
          }
          return;
        }

        // Nenhuma credencial atravessa: o motor assina pedindo ao Rust.
        const built = await buildRuntime(ready.db, ready.store, {
          settings: parsed,
          schedulerPolicy: SCHEDULER_POLICY,
        });
        if (!cancelled) {
          setSettings(parsed);
          holdRuntime(built, signature);
          setBlocked(null);
        }
      } catch (error) {
        if (cancelled) return;
        holdRuntime(null, null);
        setBlocked(
          error instanceof ConfigurationError
            ? `A configuração está incompleta: ${error.message}. Abra Configuração.`
            : describe(error),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, revision, holdRuntime]);

  // O tique vem do Rust. Um `setInterval` da webview seria estrangulado com a
  // janela escondida, e um payout que só acontece com a janela aberta não é
  // agendador.
  useEffect(() => {
    if (!runtime) return;
    const stop = listen('taps://tick', () => {
      void runtime.scheduler.tick().then(refresh, refresh);
    });
    return () => {
      void stop.then((unlisten) => unlisten());
      runtime.scheduler.stop();
    };
  }, [runtime, refresh]);

  const content = useMemo(() => {
    if (fatal) {
      return (
        <Fault
          what="O TAPS não conseguiu abrir o banco de dados"
          where="ao iniciar"
          cost={fatal}
        />
      );
    }
    if (!ready) return <p className="note">Abrindo o banco…</p>;

    switch (tab) {
      case 'inicio':
        return (
          <Home
            ready={ready}
            runtime={runtime}
            settings={settings}
            blocked={blocked}
            onGoToSettings={() => setTab('configuracao')}
            onChanged={refresh}
          />
        );
      case 'ciclos':
        return <Cycles ready={ready} settings={settings} />;
      case 'auditoria':
        return <Trail ready={ready} settings={settings} />;
      case 'backup':
        return <Backup ready={ready} onChanged={refresh} />;
      case 'migracao':
        return <Migration ready={ready} onChanged={refresh} />;
      case 'configuracao':
        return <Settings ready={ready} onSaved={refresh} />;
    }
  }, [fatal, ready, runtime, settings, blocked, tab, refresh]);

  return (
    <div className="shell">
      <nav className="rail t-dark">
        <div className="rail__mark">TAPS</div>
        <div className="rail__tag">pagar</div>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="rail__link"
            aria-current={tab === entry.id ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <div className="rail__foot">
          {ready ? `v${ready.status.version} · ${ready.status.platform}` : ''}
        </div>
      </nav>
      <main className="page">{content}</main>
    </div>
  );
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
