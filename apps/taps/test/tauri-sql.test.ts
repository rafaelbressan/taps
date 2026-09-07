import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A ponte SQL é onde o dinheiro atravessa um limite de processo.
 *
 * JSON não tem inteiro de 64 bits: um mutez acima de 2^53 que atravesse como
 * `number` volta errado, e ninguém percebe — é a mesma família de defeito que
 * fez o sistema antigo perder um mutez em 1,15% dos valores. Estes testes
 * existem para que a etiqueta de tipo não possa ser removida por engano.
 */

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const { TauriSqlDatabase } = await import('../src/lib/tauri-sql');

describe('a ponte SQL', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('manda inteiro como texto etiquetado, não como number', async () => {
    invoke.mockResolvedValue([]);
    const db = new TauriSqlDatabase();

    await db.execute('INSERT INTO t VALUES (?, ?, ?)', [
      9_007_199_254_740_993n,
      'tz1abc',
      null,
    ]);

    expect(invoke).toHaveBeenCalledWith('sql_execute', {
      token: null,
      sql: 'INSERT INTO t VALUES (?, ?, ?)',
      params: [
        { t: 'i', v: '9007199254740993' },
        { t: 's', v: 'tz1abc' },
        { t: 'n' },
      ],
    });
  });

  it('devolve inteiro como bigint, exato acima de 2^53', async () => {
    invoke.mockResolvedValue([
      [
        ['amount', { t: 'i', v: '9007199254740993' }],
        ['address', { t: 's', v: 'tz1abc' }],
        ['op_hash', { t: 'n' }],
      ],
    ]);
    const db = new TauriSqlDatabase();

    const rows = await db.query('SELECT amount, address, op_hash FROM t');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(9_007_199_254_740_993n);
    expect(rows[0]!.address).toBe('tz1abc');
    expect(rows[0]!.op_hash).toBeNull();
  });

  it('abre, comita e leva o token em toda escrita da transação', async () => {
    invoke.mockResolvedValue([]);
    const db = new TauriSqlDatabase();

    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO t VALUES (1)');
    });

    const calls = invoke.mock.calls.map((call) => call[0]);
    expect(calls).toEqual(['sql_begin', 'sql_execute', 'sql_commit']);

    const begin = invoke.mock.calls[0]![1] as { token: string };
    const write = invoke.mock.calls[1]![1] as { token: string };
    const commit = invoke.mock.calls[2]![1] as { token: string };
    expect(write.token).toBe(begin.token);
    expect(commit.token).toBe(begin.token);
  });

  it('desfaz a transação e deixa passar o erro original', async () => {
    invoke.mockResolvedValue([]);
    const db = new TauriSqlDatabase();

    await expect(
      db.transaction(async () => {
        throw new Error('a liquidação não fecha');
      }),
    ).rejects.toThrow('a liquidação não fecha');

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'sql_begin',
      'sql_rollback',
    ]);
  });

  it('não deixa o rollback esconder o erro que o causou', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'sql_rollback') return Promise.reject(new Error('rollback falhou'));
      return Promise.resolve([]);
    });
    const db = new TauriSqlDatabase();

    await expect(
      db.transaction(async () => {
        throw new Error('o motivo de verdade');
      }),
    ).rejects.toThrow('o motivo de verdade');
  });

  it('enfileira uma transação que chega durante outra, em vez de recusar', async () => {
    invoke.mockResolvedValue([]);
    const db = new TauriSqlDatabase();

    let releaseFirst: () => void = () => {};
    const first = db.transaction(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    // A primeira só chega ao corpo depois do `sql_begin`; sem esperar por isso,
    // o teste solta uma transação que ainda não começou.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A segunda chega com a primeira ainda aberta: é o tique do agendador
    // caindo no meio de uma liquidação.
    const second = db.transaction(async () => 'ok');

    releaseFirst();
    await first;
    await expect(second).resolves.toBe('ok');

    const begins = invoke.mock.calls.filter((call) => call[0] === 'sql_begin');
    const commits = invoke.mock.calls.filter((call) => call[0] === 'sql_commit');
    expect(begins).toHaveLength(2);
    expect(commits).toHaveLength(2);
    // Tokens diferentes: são duas transações, e não uma aninhada na outra.
    expect((begins[0]![1] as { token: string }).token).not.toBe(
      (begins[1]![1] as { token: string }).token,
    );
  });
});
