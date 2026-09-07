import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newestKnownSchemaVersion, type SqlRow } from '@tezos-suite/payout-store-sqlite';

/**
 * A pergunta antes da troca, como teste.
 *
 * `docs/deployment/BACKUP-E-RESTAURACAO.md` promete que o TAPS "mostra quantos
 * ciclos o backup tem e pergunta se pode seguir". A primeira versão cumpria
 * isso com `window.confirm`, e na webview do Linux nenhuma janela apareceu:
 * escolher o arquivo no diálogo já trocava o banco (BRES-124). Duas trocas
 * ficaram registradas em `taps.substituido-…` antes de alguém notar.
 *
 * A lição não é "usar um `confirm` mais confiável". É que a única barreira
 * entre clicar no arquivo errado e perder o estado atual não pode depender de
 * um diálogo que o aplicativo não desenha e não consegue testar. A confirmação
 * é da tela, e por isso cabe aqui.
 */

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

type Bridged = { t: 'i'; v: string } | { t: 's'; v: string } | { t: 'n' };

/** Uma resposta de `inspect_database`, na forma etiquetada que a ponte usa. */
function rows(records: Record<string, Bridged>[]): [string, Bridged][][] {
  return records.map((record) => Object.entries(record));
}

const int = (value: number): Bridged => ({ t: 'i', v: String(value) });

/** O banco de agora: 12 ciclos, o mais recente é o 824. */
const CURRENT: SqlRow[] = [{ n: 12n, newest: 824n }];

interface Fixture {
  /** O que `inspect_database` responde à contagem de ciclos do candidato. */
  readonly backupCycles?: [string, Bridged][][];
  readonly integrity?: string;
  readonly schemaVersion?: number;
  /** `null` quando o diálogo é cancelado. */
  readonly picked?: { token: string; name: string } | null;
}

function arrange(fixture: Fixture = {}) {
  const {
    integrity = 'ok',
    schemaVersion = newestKnownSchemaVersion(),
    picked = { token: 'tok-1', name: 'taps-2026-08-30.db' },
    backupCycles = rows([{ n: int(4), newest: int(808) }]),
  } = fixture;

  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'pick_file':
        return picked;
      case 'inspect_database': {
        const sql = String(args.sql);
        if (sql.includes('integrity_check')) {
          return rows([{ integrity_check: { t: 's', v: integrity } }]);
        }
        if (sql.includes('schema_migrations')) {
          return rows([{ version: int(schemaVersion), name: { t: 's', v: 'init' } }]);
        }
        if (sql.includes('FROM distributions')) return backupCycles;
        throw new Error(`consulta inesperada ao candidato: ${sql}`);
      }
      case 'restore_backup':
        return { replaced_copied_to: '/var/taps.db.substituido-2026-09-07T01-53-42-393Z' };
      default:
        throw new Error(`comando inesperado: ${command}`);
    }
  });

  const query = vi.fn(async () => CURRENT);
  const onChanged = vi.fn();
  const ready = { db: { query }, store: {}, schemaVersion, status: {} };
  return { onChanged, ready, query };
}

function calls(command: string) {
  return invoke.mock.calls.filter(([name]) => name === command);
}

let Backup: typeof import('../src/screens/Backup').Backup;

beforeEach(async () => {
  ({ Backup } = await import('../src/screens/Backup'));
});

function mount(fixture: Fixture = {}) {
  const { onChanged, ready } = arrange(fixture);
  render(<Backup ready={ready as never} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restaurar backup' }));
  return { onChanged };
}

describe('escolher o arquivo não troca o banco', () => {
  it('depois da conferência o banco continua o mesmo, e a tela pergunta', async () => {
    mount();

    // A pergunta aparece…
    const confirm = await screen.findByRole('button', { name: 'Restaurar' });
    expect(confirm).toBeTruthy();
    // …e nada foi trocado enquanto ela está na tela.
    expect(calls('restore_backup')).toHaveLength(0);
  });

  it('a pergunta compara os dois bancos, não só conta o backup', async () => {
    mount();

    // "este backup tem 4 ciclos, o seu banco tem 12" é a frase que evita o
    // estrago — a contagem sozinha não diz nada a quem lê.
    const linha = (await screen.findByText('Ciclos')).closest('tr');
    expect(linha?.textContent).toContain('4');
    expect(linha?.textContent).toContain('12');

    const recente = screen.getByText('Ciclo mais recente').closest('tr');
    expect(recente?.textContent).toContain('808');
    expect(recente?.textContent).toContain('824');
  });

  it('avisa quantos ciclos o banco atual tem a mais', async () => {
    mount();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('8 ciclo(s) que este backup não tem');
  });
});

describe('só o clique em Restaurar troca o banco', () => {
  it('cancelar não chama o comando e diz que nada mudou', async () => {
    const { onChanged } = mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));

    await screen.findByText(/Cancelado/);
    expect(calls('restore_backup')).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Restaurar' })).toBeNull();
  });

  it('confirmar chama `restore_backup` com o token do arquivo conferido', async () => {
    const { onChanged } = mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));

    await screen.findByText(/Restaurado\./);
    const trocas = calls('restore_backup');
    expect(trocas).toHaveLength(1);
    expect(trocas[0]?.[1]).toMatchObject({ token: 'tok-1' });
    // Caminho nenhum atravessa a fronteira: o Rust já tem o dele.
    expect(trocas[0]?.[1]).not.toHaveProperty('path');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('um arquivo recusado não chega a perguntar', () => {
  it('banco corrompido: motivo na tela, nenhuma pergunta, nenhuma troca', async () => {
    mount({ integrity: 'malformed database schema' });

    const falha = await screen.findByRole('alert');
    expect(falha.textContent).toContain('corrompido');
    expect(screen.queryByRole('button', { name: 'Restaurar' })).toBeNull();
    expect(calls('restore_backup')).toHaveLength(0);
  });

  it('backup de uma versão mais nova: recusa antes da pergunta', async () => {
    mount({ schemaVersion: newestKnownSchemaVersion() + 1 });

    const falha = await screen.findByRole('alert');
    expect(falha.textContent).toContain('atualize o TAPS');
    expect(screen.queryByRole('button', { name: 'Restaurar' })).toBeNull();
    expect(calls('restore_backup')).toHaveLength(0);
  });

  it('cancelar o diálogo de arquivo não abre pergunta nenhuma', async () => {
    mount({ picked: null });

    await waitFor(() => expect(calls('pick_file')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Restaurar' })).toBeNull();
    expect(calls('inspect_database')).toHaveLength(0);
  });
});

describe('contagem ausente não vira zero', () => {
  it('sem linha de contagem, recusa em vez de mostrar 0 ciclos', async () => {
    mount({ backupCycles: [] });

    const falha = await screen.findByRole('alert');
    expect(falha.textContent).toContain('não consegui contar os ciclos');
    expect(calls('restore_backup')).toHaveLength(0);
  });

  it('banco sem ciclo nenhum mostra travessão, não 0', async () => {
    mount({ backupCycles: rows([{ n: int(0), newest: { t: 'n' } }]) });

    const recente = (await screen.findByText('Ciclo mais recente')).closest('tr');
    expect(recente?.textContent).toContain('—');
  });
});
