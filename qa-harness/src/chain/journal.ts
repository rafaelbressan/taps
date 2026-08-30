/**
 * Diário de injeção: append-only, uma linha JSON por evento.
 *
 * Regra que ele existe para impor: **nunca apagar o registro de uma tentativa**.
 * O `opHash` é a única prova de que o dinheiro pode já ter saído. O TAPS atual tem
 * um `clearPreviousAttempt()` que apaga exatamente isso.
 *
 * Append-only e `fsync` antes de injetar: se o processo morrer entre a gravação e a
 * injeção, a retomada encontra a intenção e sabe que precisa conferir a cadeia.
 */
import { open, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InjectionRecord } from '../payout/types.ts';

export class Journal {
  constructor(private readonly dir: string) {}

  #path(key: string): string {
    return join(this.dir, `${key.replace(/[^\w.-]/g, '_')}.jsonl`);
  }

  /** Grava e faz `fsync`. Sem o fsync, "gravei antes de injetar" é uma promessa vazia. */
  async append(key: string, record: InjectionRecord): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const fh = await open(path, 'a');
    try {
      await fh.write(`${JSON.stringify(record)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async read(key: string): Promise<InjectionRecord[]> {
    const path = this.#path(key);
    if (!existsSync(path)) return [];
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as InjectionRecord);
  }
}
