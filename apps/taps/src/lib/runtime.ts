import { invoke } from '@tauri-apps/api/core';
import { RpcClient } from '@taquito/rpc';
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
  EstimationSigner,
  HttpPayoutRpc,
  OctezRemoteSigner,
  PayoutEngine,
  PayoutScheduler,
  RpcBatchInjector,
  TzKTOperationStateSource,
  buildAuthenticationPayload,
  createChunkedEstimator,
  payoutFactor,
  type EstimateTransfers,
  type QueueRequest,
  type SignerAuthenticator,
  type SignerRequest,
  type SignerTransport,
} from '@tezos-suite/payout';
import { SqlitePayoutStore, migrate } from '@tezos-suite/payout-store-sqlite';
import { TauriHttpBackend, chainFetch } from './chain-http';
import { TauriSqlDatabase } from './tauri-sql';
import type { TapsSettings } from './settings';

/**
 * A montagem do motor de payout dentro do aplicativo.
 *
 * O motor é o do estágio 4, inteiro: `PayoutEngine`, `CycleQueue`, a aritmética
 * de `@tezos-suite/chain`, a idempotência do `SqlitePayoutStore`. Não há um
 * ramo de lógica de dinheiro só para desktop — o que este arquivo faz é ligar
 * as pontas ao ambiente.
 *
 * E o ambiente mudou depois da revisão do Tezos Core & Crypto em BRES-48. O
 * que a webview **não** faz mais:
 *
 * - não segura a credencial do signer (ela assina pelo Rust, `signer_authenticate`);
 * - não escolhe endereço de rede (o Rust lê da configuração e confere);
 * - não abre conexão para fora (a CSP é `connect-src 'self'`);
 * - não escolhe caminho de arquivo (o diálogo é do Rust, e volta um token).
 *
 * O que ela continua fazendo é o que faz sentido lá: a aritmética do dinheiro,
 * a decisão de quem recebe, e o layout dos bytes de autenticação — que é a
 * parte revisada em BRES-74 e que não há razão para reescrever em Rust.
 */

/** `SignerTransport` pelo Rust. O endereço do signer não passa por aqui. */
class TauriSignerTransport implements SignerTransport {
  async send(method: 'GET' | 'POST', path: string, body?: string) {
    return invoke<{ status: number; body: string }>('signer_call', {
      method,
      path,
      body: body ?? null,
    });
  }
}

/**
 * O autenticador do signer, com a credencial do outro lado da fronteira.
 *
 * O layout — `0x04 || tag || pkh || dados` — é montado aqui por
 * `buildAuthenticationPayload`, que é o código revisado em BRES-74 e o que um
 * teste com captura de `octez-signer` de verdade fixa. O que atravessa para o
 * Rust é o payload já montado; o que volta é a assinatura. A credencial não
 * aparece em nenhum dos dois sentidos.
 */
class TauriSignerAuthenticator implements SignerAuthenticator {
  async authenticate(request: SignerRequest): Promise<string> {
    const payloadHex = buildAuthenticationPayload(request).toString('hex');
    return invoke<string>('signer_authenticate', { payloadHex });
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
  const tzkt = new TzKTHttp(network, { fetchImpl: chainFetch });
  const head = new TzKTHeadSource(tzkt);
  const rpc = new HttpPayoutRpc(settings.rpcUrl, { fetchImpl: chainFetch });

  // A configuração do signer que o motor precisa saber é o endereço de onde o
  // dinheiro sai. O ENDEREÇO DO SIGNER e a credencial ficam do lado do Rust —
  // por isso os dois campos abaixo são o que sobrou de `SignerConfig` aqui.
  const signer = new OctezRemoteSigner(
    // Sem `clientAuthKey`: ela não existe deste lado da fronteira. O
    // autenticador abaixo manda o payload para o Rust e recebe a assinatura
    // pronta, e `SignerConfig` marca o campo como opcional exatamente para
    // este caso.
    { url: settings.signerUrl, publicKeyHash: settings.signerPublicKeyHash },
    new TauriSignerAuthenticator(),
    new TauriSignerTransport(),
  );

  // Lidas uma vez por sessão e guardadas: são constantes de protocolo, mudam em
  // upgrade de protocolo, e o aplicativo é reaberto muito mais vezes que isso.
  // O que NÃO se guarda é o split do ciclo, que o motor relê antes de pagar.
  let cached: ProtocolConstants | null = null;
  const constants = async (): Promise<ProtocolConstants> => {
    if (cached) return cached;
    const raw = await chainFetch(
      `${settings.rpcUrl}/chains/main/blocks/head/context/constants`,
    );
    if (!raw.ok) {
      throw new Error(
        `o nó respondeu ${raw.status} ao pedido de constantes de protocolo — sem elas o ` +
          'motor não sabe quando um ciclo pode ser distribuído, e inventar o número foi ' +
          'o erro estrutural do sistema antigo',
      );
    }
    const header = await chainFetch(`${settings.rpcUrl}/chains/main/blocks/head/header`);
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

  // O signer da estimativa. Ele NÃO é o `signer` acima, e essa é a correção
  // do BRES-133: o `TezosToolkit` subia sem signer nenhum, e o `NoopSigner`
  // padrão do Taquito derrubava todo ciclo com "No signer has been
  // configured" — depois da fila, do split e do plano, sempre no mesmo ponto.
  //
  // Entregar o signer remoto ao toolkit teria consertado o erro e aberto uma
  // porta: o lado que só planeja passaria a ter capacidade de gastar, a um
  // `send()` de distância de um lote que nunca passou pela conferência de
  // bytes do `RpcBatchInjector`. `EstimationSigner` dá ao Taquito as duas
  // leituras que a simulação usa — endereço e chave pública — e recusa
  // assinar. A assinatura de verdade continua saindo de um lugar só.
  const estimationSigner = new EstimationSigner(settings.signerPublicKeyHash, rpc);

  const estimate: EstimateTransfers = async (recipients) => {
    // O Taquito também sai pelo Rust: com `connect-src 'self'`, um cliente HTTP
    // próprio quebraria na primeira estimativa.
    const toolkit = new TezosToolkit(
      new RpcClient(settings.rpcUrl, 'main', new TauriHttpBackend()),
    );
    toolkit.setProvider({ signer: estimationSigner });
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
