import { invoke } from '@tauri-apps/api/core';
import { TezosToolkit } from '@taquito/taquito';
import {
  TzKTHeadSource,
  TzKTHttp,
  defineNetwork,
  feeRate,
  fetchHead,
  fetchRewardSplit,
  parseProtocolConstants,
  type ProtocolConstants,
  type RewardSplit,
} from '@tezos-suite/chain';
import {
  CycleQueue,
  Ed25519ClientAuthenticator,
  HttpPayoutRpc,
  OctezRemoteSigner,
  PayoutEngine,
  PayoutScheduler,
  RpcBatchInjector,
  TzKTOperationStateSource,
  createChunkedEstimator,
  payoutFactor,
  type EstimateTransfers,
  type QueueRequest,
  type SignerConfig,
  type SignerTransport,
} from '@tezos-suite/payout';
import { SqlitePayoutStore, migrate } from '@tezos-suite/payout-store-sqlite';
import { TauriSqlDatabase } from './tauri-sql';
import type { TapsSettings } from './settings';

/**
 * A montagem do motor de payout dentro do aplicativo.
 *
 * O motor é o do estágio 4, inteiro: `PayoutEngine`, `CycleQueue`, a aritmética
 * de `@tezos-suite/chain`, a idempotência do `SqlitePayoutStore`. Não há um
 * ramo de lógica de dinheiro só para desktop — o que este arquivo faz é ligar
 * as pontas ao ambiente: o SQL passa pelo Rust, o HTTP do signer passa pelo
 * Rust, e o tique do agendador vem de um `tokio::interval` em vez de um
 * `setInterval` que a webview estrangula com a janela escondida.
 */

/** `SignerTransport` pelo Rust: o certificado do signer é do baker, não da web. */
class TauriSignerTransport implements SignerTransport {
  constructor(private readonly baseUrl: string) {}

  async send(method: 'GET' | 'POST', path: string, body?: string) {
    return invoke<{ status: number; body: string }>('signer_call', {
      url: `${this.baseUrl}${path}`,
      method,
      body: body ?? null,
    });
  }
}

export interface Runtime {
  readonly db: TauriSqlDatabase;
  readonly store: SqlitePayoutStore;
  readonly engine: PayoutEngine;
  readonly queue: CycleQueue;
  readonly scheduler: PayoutScheduler;
  readonly constants: () => Promise<ProtocolConstants>;
  readonly headCycle: () => Promise<number>;
}

export interface RuntimeOptions {
  readonly settings: TapsSettings;
  /**
   * A credencial de cliente do signer, vinda do cofre do sistema operacional.
   *
   * Ela prova ao signer QUEM está pedindo. Não é a chave que segura os fundos,
   * não produz assinatura de transferência, e uma máquina que só tem ela não
   * move nada. Fica em memória enquanto a janela viver e não vai para o banco
   * nem para o backup.
   */
  readonly clientAuthKey: string;
  readonly schedulerPolicy: {
    readonly intervalMs: number;
    readonly backoffMs: number;
    readonly maxBackoffMs: number;
  };
}

export async function openDatabase(): Promise<{
  db: TauriSqlDatabase;
  store: SqlitePayoutStore;
  schemaVersion: number;
}> {
  const db = new TauriSqlDatabase();
  const migration = await migrate(db);
  return { db, store: new SqlitePayoutStore(db), schemaVersion: migration.to };
}

export async function buildRuntime(
  db: TauriSqlDatabase,
  store: SqlitePayoutStore,
  options: RuntimeOptions,
): Promise<Runtime> {
  const { settings } = options;

  const network = defineNetwork({
    name: settings.network,
    rpcUrl: settings.rpcUrl,
    tzktApiUrl: settings.tzktApiUrl,
  });
  const tzkt = new TzKTHttp(network);
  const head = new TzKTHeadSource(tzkt);
  const rpc = new HttpPayoutRpc(settings.rpcUrl);

  const signerConfig: SignerConfig = {
    url: settings.signerUrl,
    publicKeyHash: settings.signerPublicKeyHash,
    clientAuthKey: options.clientAuthKey,
  };
  const signer = new OctezRemoteSigner(
    signerConfig,
    new Ed25519ClientAuthenticator(options.clientAuthKey),
    new TauriSignerTransport(settings.signerUrl.replace(/\/+$/, '')),
  );

  // Lidas uma vez por sessão e guardadas: são constantes de protocolo, mudam em
  // upgrade de protocolo, e o aplicativo é reaberto muito mais vezes que isso.
  // O que NÃO se guarda é o split do ciclo, que o motor relê antes de pagar.
  let cached: ProtocolConstants | null = null;
  const constants = async (): Promise<ProtocolConstants> => {
    if (cached) return cached;
    const raw = await fetch(`${settings.rpcUrl}/chains/main/blocks/head/context/constants`);
    if (!raw.ok) {
      throw new Error(
        `o nó respondeu ${raw.status} ao pedido de constantes de protocolo — sem elas o ` +
          'motor não sabe quando um ciclo pode ser distribuído, e inventar o número foi ' +
          'o erro estrutural do sistema antigo',
      );
    }
    const header = await fetch(`${settings.rpcUrl}/chains/main/blocks/head/header`);
    const headerJson = (await header.json()) as { chain_id?: string; protocol?: string };
    cached = parseProtocolConstants(
      (await raw.json()) as Record<string, unknown>,
      headerJson.chain_id ?? '',
      headerJson.protocol ?? '',
    );
    return cached;
  };

  const headCycle = async (): Promise<number> => (await fetchHead(tzkt)).cycle;

  const loadSplit = async (bakerId: string, cycle: number): Promise<RewardSplit> =>
    fetchRewardSplit(tzkt, bakerId, cycle);

  const estimate: EstimateTransfers = async (recipients) => {
    const toolkit = new TezosToolkit(settings.rpcUrl);
    const chainConstants = await constants();
    const balance = await rpc.getBalance(settings.signerPublicKeyHash);
    const estimator = createChunkedEstimator(toolkit, chainConstants, {
      gasBufferPercent: 10,
      sourceBalanceMutez: balance,
    });
    return estimator(recipients);
  };

  const engine = new PayoutEngine({
    store,
    rpc,
    signer,
    injector: new RpcBatchInjector(rpc, signer),
    operations: new TzKTOperationStateSource(tzkt, head),
    constants,
    loadSplit,
    headCycle,
    estimate,
    network: network.name,
  });

  const queue = new CycleQueue({ engine, store, constants, headCycle, loadSplit });

  const request = (): QueueRequest => ({
    bakerId: settings.bakerAddress,
    fromCycle: settings.fromCycle,
    actor: 'agendador',
    source: 'taps-desktop',
    policy: {
      fee: feeRate(settings.feeNumerator, settings.feeDenominator),
      includeBlockFees: settings.includeBlockFees,
      payoutFactor: payoutFactor(
        settings.payoutFactorNumerator,
        settings.payoutFactorDenominator,
      ),
      limits: { cycleCapMutez: settings.cycleCapMutez },
    },
    limits: { maxOwedCycles: settings.maxOwedCycles },
  });

  const scheduler = new PayoutScheduler({
    queue,
    store,
    request,
    policy: options.schedulerPolicy,
  });

  return { db, store, engine, queue, scheduler, constants, headCycle };
}

/** Pede a credencial ao cofre do sistema. Ausente é recusa, nunca modo degradado. */
export function revealClientAuthKey(): Promise<string> {
  return invoke<string>('signer_reveal_credential');
}
