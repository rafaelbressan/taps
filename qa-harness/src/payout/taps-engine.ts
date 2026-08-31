/**
 * O motor de produção do TAPS (BRES-46) por trás da interface do harness.
 *
 * O `ReferenceEngine` é o oráculo: existe para o harness ter o que exercitar e o que
 * sabotar. Este adaptador é o outro lado — quem roda aqui é `@tezos-suite/payout`, e a
 * reconciliação do harness passa a conferir contra a cadeia o que o **motor de verdade**
 * moveu.
 *
 * Duas diferenças em relação ao oráculo, e as duas são deliberadas:
 *
 *   1. **Não existe chave local.** O `ReferenceEngine` assina com `InMemorySigner` a
 *      partir do `secretKey` do coorte. O motor de produção assina num `octez-signer`
 *      remoto — decisão de custódia de 2026-08-28, opção A — e o pacote não tem signer
 *      local nenhum para cair. Rodar este adaptador exige o signer no ar.
 *   2. **O estado vive em arquivo, não em diário.** O `opHash` é gravado antes da
 *      injeção num `FilePayoutStore`, que é o que permite a retomada depois de uma morte
 *      entre injetar e confirmar.
 */
import { join } from 'node:path';
import {
  Ed25519ClientAuthenticator,
  FilePayoutStore,
  HttpPayoutRpc,
  OctezRemoteSigner,
  PayoutEngine as TapsPayoutEngineCore,
  RpcBatchInjector,
  TzKTOperationStateSource,
  buildDelegatorLines,
  loadSignerConfig,
  makeMinimumPayout,
  type EstimateTransfers,
  type PayoutStore,
} from '@tezos-suite/payout';
import {
  TzKTHeadSource,
  TzKTHttp,
  computePayout,
  defineNetwork,
  feeRate,
  parseProtocolConstants,
  rewardFieldNames,
  type EstimatedTransfer,
  type Mutez,
  type ProtocolConstants as ChainConstants,
  type RewardFieldName,
  type RewardSplit as ChainRewardSplit,
} from '@tezos-suite/chain';
import type { HarnessConfig } from '../config.ts';
import type { ProtocolConstants } from '../chain/rpc.ts';
import type { PaymentSender } from './sender.ts';
import type {
  ExecutionResult,
  InjectionRecord,
  PayoutEngine,
  PayoutPlan,
  PayoutPolicy,
  PlannedPayment,
  RewardSplit,
} from './types.ts';

export interface TapsEngineDeps {
  cfg: HarnessConfig;
  /** Constantes cruas da cadeia, como o RPC devolveu. */
  constants: ProtocolConstants;
  chainId: string;
  protocolHash: string;
  bakerAddress: string;
  /**
   * O custo medido de uma transferência, vindo da calibração do harness — que por sua
   * vez veio de `estimate.transfer` na rede. Entra aqui para que o piso do plano e o
   * piso que o motor calcula internamente sejam o mesmo número; sem isso, uma diferença
   * de um mutez na estimativa mudaria quem é pago e a reconciliação acusaria.
   */
  sender: PaymentSender;
  gasPerTransfer: bigint;
  allocationBurn: bigint;
  actor: string;
  source: string;
  /** Teto por ciclo, em mutez. Sem teto o motor recusa subir. */
  cycleCapMutez: bigint;
}

/** O que o motor produziu e o harness precisa reconciliar. */
export class TapsEngine implements PayoutEngine {
  readonly name = 'taps';

  readonly store: PayoutStore & { readonly file: string };
  readonly #core: TapsPayoutEngineCore;
  readonly #d: TapsEngineDeps;
  readonly #constants: ChainConstants;
  #lastPlanned: { split: RewardSplit; policy: PayoutPolicy } | null = null;

  constructor(deps: TapsEngineDeps) {
    this.#d = deps;
    this.#constants = parseProtocolConstants(
      deps.constants as Record<string, unknown>,
      deps.chainId,
      deps.protocolHash,
    );

    const network = defineNetwork({
      name: 'bakingnet',
      rpcUrl: deps.cfg.rpcUrl,
      tzktApiUrl: deps.cfg.tzktUrl,
    });
    const tzkt = new TzKTHttp(network, {
      concurrency: deps.cfg.tzktConcurrency,
      timeoutMs: deps.cfg.timeoutMs,
    });

    // Sem endpoint de signer configurado o construtor abaixo lança, e é isso que
    // queremos: não existe modo degradado com chave em disco.
    //
    // A autenticação de cliente só entra se houver credencial configurada. Hoje
    // ela NÃO é aceita pelo octez-signer 25.1 (ver `client-auth.ts`), então a
    // validação em Bakingnet roda sem `--require-authentication`.
    const signerConfig = loadSignerConfig();
    const signer = new OctezRemoteSigner(
      signerConfig,
      signerConfig.clientAuthKey
        ? new Ed25519ClientAuthenticator(signerConfig.clientAuthKey)
        : undefined,
    );
    const rpc = new HttpPayoutRpc(deps.cfg.rpcUrl, { timeoutMs: deps.cfg.timeoutMs });

    this.store = new FilePayoutStore(join(deps.cfg.stateDir, 'payout-engine'));
    this.#core = new TapsPayoutEngineCore({
      store: this.store,
      rpc,
      signer,
      injector: new RpcBatchInjector(rpc, signer),
      operations: new TzKTOperationStateSource(tzkt, new TzKTHeadSource(tzkt)),
      constants: async () => this.#constants,
      loadSplit: async () => this.#requireLastSplit(),
      // O harness escolhe o ciclo do cenário; a janela de denúncia é conferida pelo
      // próprio motor contra este número.
      headCycle: async () => this.#requireLastPlanned().split.cycle + this.#distributableIn(),
      estimate: this.#estimator(),
      network: network.name,
      clock: () => new Date(),
    });
  }

  /**
   * Puro, e é a mesma aritmética do motor: `computePayout` do pacote de produção, com o
   * piso vindo da estimativa da rede. O `checkPlanArithmetic` do harness recalcula tudo
   * do zero e compara — ele não chama nada daqui, que é o que o torna oráculo.
   */
  plan(split: RewardSplit, policy: PayoutPolicy): PayoutPlan {
    this.#lastPlanned = { split, policy };

    const fee = feeRate(policy.fee.num, policy.fee.den);
    const chainSplit = toChainSplit(split);
    const carryIn = new Map(policy.carryOver);

    const provisional = computePayout({
      split: chainSplit,
      fee,
      includeBlockFees: policy.includeBlockFees,
      carryIn,
      validateAddresses: false,
    });
    const feeByAddress = new Map<string, Mutez>(
      provisional.entries.map((entry): [string, Mutez] => [
        entry.address,
        this.#d.sender.estimatedTransferCost(false),
      ]),
    );

    const chainPlan = computePayout({
      split: chainSplit,
      fee,
      includeBlockFees: policy.includeBlockFees,
      carryIn,
      minimumPayout: makeMinimumPayout({
        feeByAddress,
        allocationBurn: this.#d.allocationBurn,
        bakerFloor: policy.minPayoutFloor,
      }),
      validateAddresses: false,
    });
    const lines = buildDelegatorLines(chainSplit, chainPlan, fee);

    const payments: PlannedPayment[] = lines.map((line) => ({
      address: line.address,
      earned: line.net,
      carriedIn: line.carriedIn,
      payable: line.payable,
      amount: line.amount,
      carriedOut: line.carriedOut,
      needsAllocation: line.emptied,
      reason: line.reason === 'below-cut' ? 'below-floor' : line.reason,
    }));

    return {
      cycle: split.cycle,
      baker: split.baker,
      ownShare: chainPlan.ownShare,
      bakerFee: chainPlan.bakerFee,
      dust: chainPlan.remainder,
      payments,
      totalToSend: chainPlan.totalToSend,
    };
  }

  /**
   * Executa pelo motor de produção. Chamado duas vezes com o mesmo ciclo, a segunda não
   * injeta nada — e isso não é um `if` no começo da função, é o banco recusando a
   * segunda distribuição e o hash anterior sendo conferido na cadeia.
   */
  async execute(plan: PayoutPlan): Promise<ExecutionResult> {
    const { split, policy } = this.#requireLastPlanned();
    if (plan.cycle !== split.cycle || plan.baker !== split.baker) {
      throw new Error(
        `plano de ${plan.baker}:${plan.cycle} não corresponde ao último planejado ` +
          `(${split.baker}:${split.cycle}) — o adaptador não executa um plano que não montou.`,
      );
    }

    const before = await this.#hashes(plan);
    await this.#core.run({
      bakerId: split.baker,
      cycle: split.cycle,
      actor: this.#d.actor,
      source: this.#d.source,
      policy: {
        fee: feeRate(policy.fee.num, policy.fee.den),
        includeBlockFees: policy.includeBlockFees,
        bakerFloorMutez: policy.minPayoutFloor,
        limits: { cycleCapMutez: this.#d.cycleCapMutez },
      },
    });

    const after = await this.#records(plan);
    return {
      injected: after.filter((record) => !before.has(record.opHash)),
      skipped: after.filter((record) => before.has(record.opHash)),
    };
  }

  /**
   * A morte entre a injeção e a confirmação, reproduzida no estado que o motor de
   * produção realmente deixa: o `opHash` JÁ está gravado, porque ele é escrito antes de
   * injetar.
   *
   * Por isso a retomada aqui **não recusa** — ela pergunta à cadeia pelo hash, encontra
   * a operação aplicada e fecha o ciclo sem reenviar. É o que a RN-12 manda: "a consulta
   * on-chain diz 'aplicada'; o sistema fecha o ciclo como pago e não reenvia". Recusar
   * seria o certo apenas para quem não gravou o hash e portanto não sabe.
   */
  async simulateCrash(
    plan: PayoutPlan,
  ): Promise<{ injected: number; refused: boolean; resolved: boolean; message: string }> {
    const snapshot = await this.store.getDistribution(plan.baker, plan.cycle);
    if (!snapshot) {
      return { injected: 0, refused: false, resolved: false, message: 'sem distribuição gravada' };
    }
    const withHash = snapshot.batches.filter((batch) => batch.opHash !== null);
    if (withHash.length === 0) {
      return { injected: 0, refused: false, resolved: false, message: 'nenhum lote com hash gravado' };
    }

    // Volta o estado para o instante seguinte a `recordInjectionIntent`: lote `pending`,
    // hash no lugar, distribuição em `sending`. É o retrato exato de uma morte ali.
    for (const batch of withHash) {
      await this.store.recordBatchStatus({
        bakerId: plan.baker,
        cycle: plan.cycle,
        index: batch.index,
        status: 'pending',
        confirmedAt: null,
      });
    }
    await this.store.setDistributionStatus(plan.baker, plan.cycle, 'sending', new Date());

    const before = await this.#hashes(plan);
    try {
      await this.#core.run({
        bakerId: plan.baker,
        cycle: plan.cycle,
        actor: this.#d.actor,
        source: `${this.#d.source} (retomada após morte simulada)`,
        policy: {
          fee: feeRate(this.#requireLastPlanned().policy.fee.num, this.#requireLastPlanned().policy.fee.den),
          includeBlockFees: this.#requireLastPlanned().policy.includeBlockFees,
          bakerFloorMutez: this.#requireLastPlanned().policy.minPayoutFloor,
          limits: { cycleCapMutez: this.#d.cycleCapMutez },
        },
      });
    } catch (err) {
      // Recusa explícita também passa: é o comportamento correto para um estado que o
      // motor não consegue resolver contra a cadeia.
      return {
        injected: 0,
        refused: true,
        resolved: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const after = await this.#records(plan);
    const injected = after.filter((record) => !before.has(record.opHash)).length;
    return {
      injected,
      refused: false,
      resolved: injected === 0,
      message:
        injected === 0
          ? `retomou pelos hashes gravados (${[...before].join(', ')}) e conferiu na cadeia; ` +
            'nenhuma operação nova'
          : `a retomada injetou ${injected} operação(ões)`,
    };
  }

  /**
   * A estimativa do motor usa os mesmos números que o harness calibrou na rede, para que
   * o plano do adaptador e o plano interno do motor coincidam. O `storage_limit` de quem
   * precisa ser alocado vem de `origination_size` lido da cadeia — nunca zero fixo.
   */
  #estimator(): EstimateTransfers {
    return async (recipients): Promise<EstimatedTransfer[]> =>
      recipients.map((recipient) => ({
        address: recipient.address,
        amount: recipient.amount,
        gasLimit: this.#d.gasPerTransfer,
        storageLimit: recipient.emptied ? BigInt(this.#constants.originationSize) : 0n,
        feeMutez: this.#d.sender.estimatedTransferCost(false),
        burnMutez: recipient.emptied ? this.#d.allocationBurn : 0n,
      }));
  }

  #distributableIn(): number {
    return this.#constants.denunciationPeriod + this.#constants.slashingDelay;
  }

  #requireLastPlanned(): { split: RewardSplit; policy: PayoutPolicy } {
    if (!this.#lastPlanned) {
      throw new Error('execute() antes de plan(): o adaptador não inventa um plano.');
    }
    return this.#lastPlanned;
  }

  #requireLastSplit(): ChainRewardSplit {
    return toChainSplit(this.#requireLastPlanned().split);
  }

  async #records(plan: PayoutPlan): Promise<InjectionRecord[]> {
    const snapshot = await this.store.getDistribution(plan.baker, plan.cycle);
    if (!snapshot) return [];
    return snapshot.batches
      .filter((batch) => batch.opHash !== null)
      .map((batch) => ({
        opHash: batch.opHash!,
        counter: batch.counter ?? '',
        branchLevel: batch.branchLevel ?? 0,
        addresses: batch.transfers.map((transfer) => transfer.address),
        amounts: batch.transfers.map((transfer) => transfer.amountMutez.toString()),
        injectedAt: (batch.injectedAt ?? new Date()).toISOString(),
      }));
  }

  async #hashes(plan: PayoutPlan): Promise<Set<string>> {
    return new Set((await this.#records(plan)).map((record) => record.opHash));
  }
}

/**
 * O split do harness na forma que o pacote de cadeia entende.
 *
 * `stakedSharedRewards` entra no campo `attestationRewardsStakedShared` de propósito:
 * assim o motor o **reporta** como já liquidado e continua não o distribuindo. Zerá-lo
 * aqui esconderia o campo do teste em vez de provar que ele é ignorado.
 */
function toChainSplit(split: RewardSplit): ChainRewardSplit {
  const rewards = {} as Record<RewardFieldName, Mutez>;
  for (const field of rewardFieldNames()) rewards[field] = 0n;
  rewards.blockRewardsDelegated = split.liquidPool;
  rewards.attestationRewardsStakedShared = split.stakedSharedRewards;

  return {
    baker: split.baker,
    cycle: split.cycle,
    ownDelegatedBalance: split.ownDelegatedBalance,
    externalDelegatedBalance: split.externalDelegatedBalance,
    ownStakedBalance: 0n,
    externalStakedBalance: split.stakers.reduce((sum, s) => sum + s.stakedBalance, 0n),
    delegatorsCount: split.delegatorsCount,
    stakersCount: split.stakers.length,
    bakingPower: 0n,
    totalBakingPower: 0n,
    blockFees: split.blockFees,
    futureBlocks: 0,
    rewards: Object.freeze(rewards),
    delegators: split.delegators.map((d) => ({
      address: d.address,
      delegatedBalance: d.delegatedBalance,
      emptied: d.emptied,
    })),
    stakers: split.stakers.map((s) => ({ address: s.address, stakedBalance: s.stakedBalance })),
    actualStakers: [],
  };
}
