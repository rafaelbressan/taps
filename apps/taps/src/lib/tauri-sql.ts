import { invoke } from '@tauri-apps/api/core';
import type { SqlDatabase, SqlRow, SqlTransaction, SqlValue } from '@tezos-suite/payout-store-sqlite';

/**
 * `SqlDatabase` sobre a conexão que o Rust abriu.
 *
 * O motor de payout, as migrations e o `SqlitePayoutStore` são os mesmos do
 * pacote — o que muda é só por onde o SQL passa. É isso que faz o critério
 * "nenhum ramo de lógica de dinheiro só para desktop" ser verificável em vez de
 * prometido: se o driver estivesse errado, os 40 testes de contrato do pacote
 * continuariam passando e o baker é que descobriria.
 *
 * Inteiro atravessa como texto etiquetado. JSON não tem inteiro de 64 bits, e
 * um mutez que volte como `number` acima de 2^53 volta errado em silêncio.
 */

type Bridged =
  | { t: 'i'; v: string }
  | { t: 's'; v: string }
  | { t: 'f'; v: number }
  | { t: 'n' };

function encode(value: SqlValue): Bridged {
  if (value === null) return { t: 'n' };
  if (typeof value === 'bigint') return { t: 'i', v: value.toString() };
  if (typeof value === 'string') return { t: 's', v: value };
  if (typeof value === 'number') {
    // Um inteiro que chegou como `number` vira INTEGER; o resto é REAL, e
    // nenhuma coluna de dinheiro do schema é REAL.
    return Number.isInteger(value) ? { t: 'i', v: value.toString() } : { t: 'f', v: value };
  }
  throw new TypeError(
    'a ponte SQL carrega texto, inteiro, real e nulo — o schema do TAPS não tem BLOB',
  );
}

function decode(value: Bridged): SqlValue {
  switch (value.t) {
    case 'n':
      return null;
    case 'i':
      return BigInt(value.v);
    case 's':
      return value.v;
    case 'f':
      return value.v;
  }
}

function toRow(record: readonly [string, Bridged][]): SqlRow {
  const row: Record<string, SqlValue> = {};
  for (const [name, value] of record) row[name] = decode(value);
  return row;
}

export class TauriSqlDatabase implements SqlDatabase {
  private token: string | null = null;
  /**
   * Fila de uma posição só.
   *
   * O Rust já recusa uma escrita fora da transação aberta, e isso é a rede de
   * segurança. Esta fila é a primeira: sem ela, um tique do agendador chegando
   * durante uma liquidação viraria um erro na cara do baker em vez de esperar
   * dois segundos.
   */
  private chain: Promise<unknown> = Promise.resolve();

  private serialise<T>(body: () => Promise<T>): Promise<T> {
    const next = this.chain.then(body, body);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const rows = await invoke<[string, Bridged][][]>('sql_query', {
      token: this.token,
      sql,
      params: params.map(encode),
    });
    return rows.map(toRow);
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    await invoke('sql_execute', {
      token: this.token,
      sql,
      params: params.map(encode),
    });
  }

  async transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    return this.serialise(async () => {
      if (this.token !== null) {
        throw new Error(
          'já existe uma transação aberta nesta conexão — aninhar transformaria um ' +
            'rollback em escrita parcial',
        );
      }
      const token = crypto.randomUUID();
      await invoke('sql_begin', { token });
      this.token = token;
      try {
        const result = await body(this);
        await invoke('sql_commit', { token });
        return result;
      } catch (error) {
        // O rollback não pode esconder o erro original: se ele próprio falhar,
        // o que o baker precisa ler é o primeiro.
        try {
          await invoke('sql_rollback', { token });
        } catch {
          /* o SQLite já desfez a transação; o erro que importa é o de cima */
        }
        throw error;
      } finally {
        this.token = null;
      }
    });
  }

  async close(): Promise<void> {
    // A conexão é do Rust e vive enquanto a janela viver. Fechar aqui seria
    // fechar o banco de baixo de quem ainda está usando.
  }
}

/** Abre outro arquivo só para leitura, para conferir um backup antes de restaurar. */
export async function queryOtherDatabase(path: string, sql: string): Promise<SqlRow[]> {
  const rows = await invoke<[string, Bridged][][]>('inspect_database', { path, sql });
  return rows.map(toRow);
}
