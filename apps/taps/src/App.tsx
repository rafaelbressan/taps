import { useCallback, useEffect, useMemo, useState } from 'react';
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
            setRuntime(null);
            setBlocked(
              `O TAPS ainda não está configurado. Falta preencher: ${missing
                .map((entry) => entry.label)
                .join(', ')}. Abra Configuração.`,
            );
          }
          return;
        }

        const parsed = parseSettings(raw);
        if (!ready.status.signer_credential_present) {
          if (!cancelled) {
            setSettings(parsed);
            setRuntime(null);
            setBlocked(
              'Falta a credencial de cliente do octez-signer. É com ela que este computador ' +
                'prova ao signer quem está pedindo, e sem ela o signer recusa o pedido. Abra ' +
                'Configuração e escolha o arquivo da chave que você autorizou no signer.',
            );
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
          setRuntime(built);
          setBlocked(null);
        }
      } catch (error) {
        if (cancelled) return;
        setRuntime(null);
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
  }, [ready, revision]);

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
