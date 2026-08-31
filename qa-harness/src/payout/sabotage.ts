/**
 * Mutantes: cada um remove **uma** proteção do motor de referência.
 *
 * Razão de existirem: um teste que não pode reprovar não é um teste. O `selftest`
 * roda o harness contra cada mutante e exige que ele **reprove**. Se um mutante
 * passa, o cenário que deveria pegá-lo é decorativo e o harness diz isso.
 *
 * Cada mutante reproduz um bug real, catalogado no levantamento de rede (BRES-38)
 * ou na análise do TAPS.
 */

export const MUTANTS = {
  idempotency: {
    label: 'idempotência removida',
    breaks: 'não consulta o diário antes de injetar; a segunda execução paga de novo',
    origin: 'ANALYSIS §21 — retry reenvia sem consultar o opHash anterior',
    caughtBy: 'idempotencia-execucao-dupla',
  },
  'storage-limit': {
    label: 'storageLimit fixo em 0',
    breaks: 'destino não alocado derruba o lote inteiro (backtracked, sem erro próprio)',
    origin: 'BRES-38 §5.2 — transaction.service.ts:182',
    caughtBy: 'conta-nao-alocada',
  },
  'tz4-rejected': {
    label: 'validação de endereço por regex sem tz4',
    breaks: 'delegador tz4 é reprovado na validação e não recebe',
    origin: 'BRES-38 §4.3 — ADDRESS_PATTERNS sem tz4',
    caughtBy: 'delegador-tz4',
  },
  'batch-cap': {
    label: 'MAX_BATCH_SIZE=100 sem dividir',
    breaks: 'acima de 100 destinatários o lote é cortado em silêncio',
    origin: 'ANALYSIS — MAX_BATCH_SIZE = 100',
    caughtBy: 'acima-de-100-delegadores',
  },
  'float-mutez': {
    label: 'conversão de valor com float',
    breaks: '1,15 % dos valores perdem 1 mutez, sempre para baixo',
    origin: 'BRES-38 §5.4 — tezToMutez com Math.floor(tez*1e6)',
    caughtBy: 'aritmetica-fecha',
  },
  'pagination-truncated': {
    label: 'lê só a primeira página de delegadores',
    breaks: 'paga a mais para os listados e zero para o resto, sem erro',
    origin: 'BRES-38 §2.5/§2.6 — limite padrão 100',
    caughtBy: 'lista-de-delegadores-completa',
  },
  'pay-staked-shared': {
    label: 'inclui *StakedShared no pool distribuível',
    breaks: 'paga de novo o que o protocolo já creditou aos stakers',
    origin: 'BRES-38 §2.2 — pagamento duplicado',
    caughtBy: 'aritmetica-fecha',
  },
  'stakers-as-delegators': {
    label: 'trata stakers como delegadores',
    breaks: 'inclui no batch quem o protocolo já pagou',
    origin: 'BRES-38 §3.1 — o TAPS ignora staked_balance por completo',
    caughtBy: 'staker-nao-recebe-por-fora',
  },
  'no-floor': {
    label: 'sem piso de pagamento',
    breaks: 'paga poeira que custa mais em taxa do que o valor transferido',
    origin: 'BRES-38 §3.6 — 63 % dos delegadores recebem ≤ o custo de pagá-los',
    caughtBy: 'valor-de-poeira',
  },
} as const;

export type MutantName = keyof typeof MUTANTS;

export function isMutantName(s: string): s is MutantName {
  return Object.prototype.hasOwnProperty.call(MUTANTS, s);
}

export class Sabotage {
  private readonly active: ReadonlySet<string>;

  constructor(mutants: readonly MutantName[] = []) {
    this.active = new Set(mutants);
  }

  has(m: MutantName): boolean {
    return this.active.has(m);
  }

  get names(): MutantName[] {
    return [...this.active] as MutantName[];
  }

  get isClean(): boolean {
    return this.active.size === 0;
  }
}
