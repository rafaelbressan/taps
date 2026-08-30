/**
 * Cliente TzKT do harness — só leitura, e só o que a reconciliação precisa.
 *
 * Este cliente existe para **conferir** o TAPS, não para servi-lo. Ele nunca lê o
 * banco do sistema: a comparação é sempre contra a cadeia (TzKT) ou contra a RPC.
 *
 * Powered by TzKT API — https://tzkt.io (atribuição exigida pelo free tier).
 */
import type { HarnessConfig } from '../config.ts';
import { assertAllowedChainId } from '../guard.ts';
import { fetchJson, mapLimit, sleep } from './http.ts';

/** Atraso tolerado do indexador, em blocos. Acima disso, o dado é velho demais. */
const MAX_INDEXER_LAG = 2;

export interface TzktHead {
  chainId: string;
  cycle: number;
  level: number;
  protocol: string;
  synced: boolean;
  lastSync: string;
}

export interface TzktTransaction {
  type: string;
  hash: string;
  level: number;
  block: string;
  timestamp: string;
  status: string;
  counter: number;
  sender: { address: string };
  target?: { address: string };
  amount: number;
  bakerFee: number;
  storageFee: number;
  allocationFee: number;
}

export type OpStatus = 'applied' | 'failed' | 'unknown';

export class TzktClient {
  #verified = false;

  constructor(private readonly cfg: HarnessConfig) {}

  async assertBakingnet(): Promise<TzktHead> {
    let last = '';
    // Um bloco de atraso é latência normal de indexação, e o `synced` da TzKT oscila
    // para `false` nesse instante. O que não pode passar é atraso que persiste: aí a
    // reconciliação estaria comparando dinheiro contra um retrato velho.
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { body, headers } = await fetchJson<TzktHead>(`${this.cfg.tzktUrl}/v1/head`, {
        timeoutMs: this.cfg.timeoutMs,
      });
      if (!body) throw new Error('TzKT devolveu head vazio.');
      assertAllowedChainId(`TzKT ${this.cfg.tzktUrl}`, body.chainId);

      const level = Number(headers.get('tzkt-level') ?? body.level);
      const known = Number(headers.get('tzkt-known-level') ?? body.level);
      const lag = known - level;
      if (lag <= MAX_INDEXER_LAG) {
        this.#verified = true;
        return body;
      }
      last =
        `TzKT atrasado em ${lag} bloco(s): level ${level}, known ${known}, ` +
        `synced-at ${headers.get('tzkt-synced-at') ?? '?'}`;
      await sleep(4000 * attempt);
    }
    throw new Error(`${last}. Não reconcilie dinheiro contra dado velho.`);
  }

  #requireVerified(): void {
    if (!this.#verified) {
      throw new Error('uso indevido do harness: TzktClient.assertBakingnet() não foi chamado.');
    }
  }

  /**
   * Estado de uma operação pelo hash.
   * 200 `true` → aplicada; 200 `false` → rejeitada; **204 corpo vazio** → desconhecida.
   * Tratar 204 como "não paga" é o que gera pagamento duplicado.
   */
  async operationStatus(hash: string): Promise<OpStatus> {
    this.#requireVerified();
    const { status, body } = await fetchJson<boolean>(
      `${this.cfg.tzktUrl}/v1/operations/${hash}/status`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    if (status === 204 || body === undefined) return 'unknown';
    return body ? 'applied' : 'failed';
  }

  /** Todas as transações de um hash de operação (um batch tem várias). */
  async transactionsByHash(hash: string): Promise<TzktTransaction[]> {
    this.#requireVerified();
    const { body } = await fetchJson<TzktTransaction[]>(
      `${this.cfg.tzktUrl}/v1/operations/transactions/${hash}`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    return body ?? [];
  }

  /**
   * Transações enviadas por `sender` a partir de um nível. Paginação **iterada**:
   * limite padrão 100, máximo 10 000. Uma página só nunca é resposta.
   */
  async transactionsFrom(sender: string, fromLevel: number): Promise<TzktTransaction[]> {
    this.#requireVerified();
    const pageSize = 10_000;
    const out: TzktTransaction[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const url =
        `${this.cfg.tzktUrl}/v1/operations/transactions` +
        `?sender=${sender}&level.ge=${fromLevel}&limit=${pageSize}&offset=${offset}&sort.asc=id`;
      const { body } = await fetchJson<TzktTransaction[]>(url, { timeoutMs: this.cfg.timeoutMs });
      const page = body ?? [];
      out.push(...page);
      if (page.length < pageSize) return out;
    }
  }

  /** Saldos de um conjunto de endereços, com concorrência limitada. */
  async balances(addresses: readonly string[]): Promise<Map<string, bigint>> {
    this.#requireVerified();
    const results = await mapLimit(addresses, this.cfg.tzktConcurrency, async (addr) => {
      const { status, body } = await fetchJson<number>(
        `${this.cfg.tzktUrl}/v1/accounts/${addr}/balance`,
        { timeoutMs: this.cfg.timeoutMs },
      );
      // Conta nunca vista pelo indexador: saldo zero, não erro.
      if (status === 204 || body === undefined) return [addr, 0n] as const;
      return [addr, BigInt(body)] as const;
    });
    return new Map(results);
  }
}
