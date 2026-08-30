/**
 * Leituras da RPC do nó Octez. Fonte de verdade independente do indexador.
 *
 * Nenhuma constante de protocolo é escrita aqui. `blocks_per_cycle` difere entre
 * mainnet (14400) e Bakingnet (3600) — um valor no código erra por 4× em silêncio.
 */
import type { HarnessConfig } from '../config.ts';
import { assertAllowedChainId } from '../guard.ts';
import { fetchJson } from './http.ts';

export interface ProtocolConstants {
  blocks_per_cycle: number;
  minimal_block_delay: string | number;
  hard_gas_limit_per_operation: string;
  hard_gas_limit_per_block: string;
  hard_storage_limit_per_operation: string;
  cost_per_byte: string;
  origination_size: number;
  max_operations_time_to_live: number;
  consensus_rights_delay: number;
  edge_of_staking_over_delegation: number;
  minimal_stake: string;
  [k: string]: unknown;
}

export interface BlockHeader {
  level: number;
  hash: string;
  chain_id: string;
  protocol: string;
  timestamp: string;
}

export class RpcClient {
  #chainIdVerified = false;

  constructor(private readonly cfg: HarnessConfig) {}

  /**
   * Trava de rede. Roda antes de qualquer outra leitura e antes de qualquer escrita.
   * Chamar duas vezes é barato; não chamar é o que não pode acontecer.
   */
  async assertBakingnet(): Promise<string> {
    const url = `${this.cfg.rpcUrl}/chains/main/chain_id`;
    const { body } = await fetchJson<string>(url, { timeoutMs: this.cfg.timeoutMs });
    assertAllowedChainId(`RPC ${this.cfg.rpcUrl}`, body);
    this.#chainIdVerified = true;
    return body;
  }

  #requireVerified(): void {
    if (!this.#chainIdVerified) {
      throw new Error('uso indevido do harness: assertBakingnet() não foi chamado antes desta leitura.');
    }
  }

  async header(): Promise<BlockHeader> {
    this.#requireVerified();
    const { body } = await fetchJson<BlockHeader>(
      `${this.cfg.rpcUrl}/chains/main/blocks/head/header`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    if (!body) throw new Error('RPC devolveu header vazio.');
    assertAllowedChainId('RPC header', body.chain_id);
    return body;
  }

  /** Constantes lidas da cadeia. Campo ausente → erro alto com o nome do campo. */
  async constants(): Promise<ProtocolConstants> {
    this.#requireVerified();
    const { body } = await fetchJson<ProtocolConstants>(
      `${this.cfg.rpcUrl}/chains/main/blocks/head/context/constants`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    if (!body) throw new Error('RPC devolveu constantes vazias.');
    const required = [
      'blocks_per_cycle',
      'minimal_block_delay',
      'hard_gas_limit_per_operation',
      'hard_gas_limit_per_block',
      'cost_per_byte',
      'origination_size',
      'max_operations_time_to_live',
      'edge_of_staking_over_delegation',
      'minimal_stake',
    ] as const;
    const missing = required.filter((k) => body[k] === undefined);
    if (missing.length > 0) {
      throw new Error(
        `constantes de protocolo ausentes na resposta da RPC: ${missing.join(', ')}. ` +
          `Nunca caia num default — o valor pertence à cadeia.`,
      );
    }
    return body;
  }

  /** Saldo em mutez. `bigint` do começo ao fim. */
  async balance(address: string): Promise<bigint> {
    this.#requireVerified();
    const { body } = await fetchJson<string>(
      `${this.cfg.rpcUrl}/chains/main/blocks/head/context/contracts/${address}/balance`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    if (body === undefined) throw new Error(`RPC não devolveu saldo de ${address}.`);
    return BigInt(body);
  }

  /**
   * `true` quando a conta está alocada — isto é, quando pagá-la **não** cobra o burn
   * de storage.
   *
   * Não dá para testar isso por código de status: a RPC responde **200 com `"0"`**
   * para uma conta que nunca existiu, não 404. Para conta implícita o critério é o
   * saldo: saldo zero significa desalocada, e a próxima transferência para ela queima
   * `origination_size × cost_per_byte`. É essa conta que o `storageLimit: 0` derruba,
   * levando o lote inteiro junto.
   */
  async isAllocated(address: string): Promise<boolean> {
    this.#requireVerified();
    const { body } = await fetchJson<string>(
      `${this.cfg.rpcUrl}/chains/main/blocks/head/context/contracts/${address}/balance`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    return body !== undefined && BigInt(body) > 0n;
  }

  /** Counter da conta de origem — trava barata de idempotência (BRES-38 §6.4). */
  async counter(address: string): Promise<bigint> {
    this.#requireVerified();
    const { body } = await fetchJson<string>(
      `${this.cfg.rpcUrl}/chains/main/blocks/head/context/contracts/${address}/counter`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    if (body === undefined) throw new Error(`RPC não devolveu counter de ${address}.`);
    return BigInt(body);
  }

  /** Hashes de operação de um nível — conferência sem depender do indexador. */
  async operationHashes(level: number): Promise<string[][]> {
    this.#requireVerified();
    const { body } = await fetchJson<string[][]>(
      `${this.cfg.rpcUrl}/chains/main/blocks/${level}/operation_hashes`,
      { timeoutMs: this.cfg.timeoutMs },
    );
    return body ?? [];
  }
}
