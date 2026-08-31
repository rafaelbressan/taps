/**
 * Endpoints e parâmetros do harness.
 *
 * Regra do BRES-38/BRES-42: endpoint vem de configuração, nunca de critério de aceite
 * e nunca de constante de negócio no código. Os defaults abaixo existem só para o
 * harness rodar sem ceremônia; qualquer um deles pode ser trocado por env.
 *
 * O que NÃO é configurável é a rede — ver `guard.ts`.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { assertNotMainnetUrl } from './guard.ts';

export interface HarnessConfig {
  /** RPC do nó Octez. */
  rpcUrl: string;
  /** Indexador TzKT da mesma rede. */
  tzktUrl: string;
  /** Faucet do teztnets. */
  faucetUrl: string;
  /** Onde ficam as chaves do coorte e o diário de pagamentos. */
  stateDir: string;
  /** Onde os relatórios são escritos. */
  reportDir: string;
  /** Concorrência máxima contra a TzKT (BRES-38 §2.8: 1–4). */
  tzktConcurrency: number;
  /** Timeout de rede, ms. */
  timeoutMs: number;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function loadConfig(): HarnessConfig {
  const cfg: HarnessConfig = {
    rpcUrl: env('TAPS_QA_RPC_URL', 'https://rpc.bakingnet.teztnets.com'),
    tzktUrl: env('TAPS_QA_TZKT_URL', 'https://api.bakingnet.tzkt.io'),
    faucetUrl: env('TAPS_QA_FAUCET_URL', 'https://faucet.bakingnet.teztnets.com'),
    stateDir: env('TAPS_QA_STATE_DIR', resolve(process.cwd(), 'state')),
    reportDir: env('TAPS_QA_REPORT_DIR', resolve(process.cwd(), 'reports')),
    tzktConcurrency: Number(env('TAPS_QA_TZKT_CONCURRENCY', '2')),
    timeoutMs: Number(env('TAPS_QA_TIMEOUT_MS', '45000')),
  };

  // A trava de URL roda antes de qualquer I/O.
  assertNotMainnetUrl('RPC', cfg.rpcUrl);
  assertNotMainnetUrl('TzKT', cfg.tzktUrl);
  assertNotMainnetUrl('faucet', cfg.faucetUrl);

  if (cfg.stateDir.startsWith('/tmp') || cfg.stateDir === homedir()) {
    throw new Error(`state dir inválido: ${cfg.stateDir}`);
  }
  if (!Number.isInteger(cfg.tzktConcurrency) || cfg.tzktConcurrency < 1 || cfg.tzktConcurrency > 4) {
    throw new Error('TAPS_QA_TZKT_CONCURRENCY precisa estar entre 1 e 4 (BRES-38 §2.8).');
  }
  return cfg;
}
