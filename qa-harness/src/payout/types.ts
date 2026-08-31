/**
 * O contrato que o motor de payout do TAPS (BRES-46) precisa cumprir para ser
 * testável por este harness.
 *
 * O harness não conhece a implementação. Ele dá um `RewardSplit` e um `PayoutPolicy`,
 * recebe um `PayoutPlan`, manda executar, e depois confere o resultado **contra a
 * cadeia** — nunca contra o banco de quem implementou.
 *
 * Todo valor monetário é `bigint` em mutez. Não existe `number` de dinheiro aqui.
 */

/** Um delegador no snapshot do ciclo. Espelha `/v1/rewards/split/{baker}/{cycle}`. */
export interface SplitDelegator {
  address: string;
  delegatedBalance: bigint;
  /** Conta esvaziada — precisa ser realocada, e realocar custa storage. */
  emptied: boolean;
}

/**
 * O que o motor recebe. Só os campos que entram na conta.
 * `*StakedShared`, `*StakedOwn` e `*StakedEdge` ficam de fora **de propósito**:
 * o protocolo já pagou os stakers, e pagar de novo é pagar em dobro.
 */
export interface RewardSplit {
  cycle: number;
  baker: string;
  /** Σ dos campos `*Delegated` — o único pool que o baker distribui à mão. */
  liquidPool: bigint;
  /** Taxas de bloco; entram no pool só se a política mandar. */
  blockFees: bigint;
  ownDelegatedBalance: bigint;
  externalDelegatedBalance: bigint;
  delegators: SplitDelegator[];
  /** Conferência de completude: `delegatorsCount` reportado pela API. */
  delegatorsCount: number;
  /**
   * Σ dos campos `*StakedShared`: o rendimento que o **protocolo já creditou** aos
   * stakers. Está aqui por um motivo só — para o harness poder provar que somá-lo ao
   * pool é pagamento duplicado. **Um motor correto nunca lê este campo.**
   */
  stakedSharedRewards: bigint;
  /**
   * Quem stakeia com este baker. Mesma razão do campo acima: está aqui para o harness
   * poder provar que pagar estas contas é pagamento duplicado. **Um motor correto nunca
   * as inclui num batch** — o protocolo já credita o rendimento delas.
   */
  stakers: { address: string; stakedBalance: bigint }[];
}

/** Taxa como racional inteiro. Float em dinheiro é bug, não estilo. */
export interface FeeRational {
  num: bigint;
  den: bigint;
}

export interface PayoutPolicy {
  fee: FeeRational;
  includeBlockFees: boolean;
  /**
   * Piso configurável por baker, em mutez. O piso **efetivo** é
   * `max(minPayoutFloor, taxa estimada da própria transferência)` — decisão A do
   * BRES-38 §3.6. Nunca uma constante de rede escrita no código.
   */
  minPayoutFloor: bigint;
  /** Saldo pendente herdado de ciclos anteriores, por endereço. */
  carryOver: Map<string, bigint>;
}

/** Uma linha do plano: quem recebe quanto, e por quê. */
export interface PlannedPayment {
  address: string;
  /** Devido neste ciclo, antes do piso. */
  earned: bigint;
  /** Saldo herdado de ciclos anteriores. */
  carriedIn: bigint;
  /** `earned + carriedIn`. É este valor que se compara com o piso. */
  payable: bigint;
  /** O que efetivamente entra no batch. `0n` quando fica abaixo do piso. */
  amount: bigint;
  /** O que sobra para o próximo ciclo. Acumular e nunca pagar é não pagar. */
  carriedOut: bigint;
  /** Precisa de storage para realocar o destino. */
  needsAllocation: boolean;
  reason: 'paid' | 'below-floor' | 'zero';
}

export interface PayoutPlan {
  cycle: number;
  baker: string;
  /** A parte do pool que corresponde ao saldo delegado do próprio baker. */
  ownShare: bigint;
  /** Taxa do baker sobre a parte externa. */
  bakerFee: bigint;
  /** Sobra de arredondamento; fica com o baker. Nunca se inventa mutez. */
  dust: bigint;
  payments: PlannedPayment[];
  /** Σ dos `amount` que entram no batch. */
  totalToSend: bigint;
}

/** Registro de uma injeção. Gravado ANTES de injetar — é a prova de que o dinheiro pode ter saído. */
export interface InjectionRecord {
  opHash: string;
  counter: string;
  branchLevel: number;
  addresses: string[];
  amounts: string[];
  injectedAt: string;
}

export interface ExecutionResult {
  /** Operações realmente injetadas nesta execução. Vazio = nada foi enviado. */
  injected: InjectionRecord[];
  /** Operações puladas por já constarem no diário. É isto que a idempotência produz. */
  skipped: InjectionRecord[];
}

/** O motor sob teste. BRES-46 implementa esta interface. */
export interface PayoutEngine {
  readonly name: string;
  /** Calcula o plano. Puro: sem rede, sem escrita. */
  plan(split: RewardSplit, policy: PayoutPolicy): PayoutPlan;
  /**
   * Executa o plano na cadeia.
   * Precisa ser **idempotente**: chamada duas vezes com o mesmo `(baker, cycle)`,
   * a segunda não injeta nada.
   */
  execute(plan: PayoutPlan): Promise<ExecutionResult>;
}
