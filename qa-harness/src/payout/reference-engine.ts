/**
 * Motor de referência: a fórmula do BRES-38 §3.4, implementada em `bigint`.
 *
 * Ele existe por dois motivos:
 *   1. O harness precisa de algo para exercitar enquanto o motor do TAPS (BRES-46)
 *      não existe. Trocar um pelo outro é trocar a implementação de `PayoutEngine`.
 *   2. Ele é o corpo sobre o qual os mutantes operam. Sem um motor correto para
 *      sabotar, não há como provar que os cenários reprovam.
 *
 * Este NÃO é o motor de produção do TAPS. É o oráculo do teste.
 */
import { validateAddress, ValidationResult } from '@taquito/utils';
import type {
  ExecutionResult,
  PayoutEngine,
  PayoutPlan,
  PayoutPolicy,
  PlannedPayment,
  RewardSplit,
} from './types.ts';
import { Sabotage } from './sabotage.ts';
import type { Batcher } from '../chain/batcher.ts';

/** Regex do TAPS atual, reproduzida só para o mutante `tz4-rejected`. */
const LEGACY_ADDRESS_RE = /^(tz1|tz2|tz3|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/;

export class ReferenceEngine implements PayoutEngine {
  readonly name = 'reference';

  constructor(
    private readonly batcher: Batcher,
    private readonly sabotage = new Sabotage(),
  ) {}

  plan(split: RewardSplit, policy: PayoutPolicy): PayoutPlan {
    let pool = split.liquidPool;
    if (policy.includeBlockFees) pool += split.blockFees;

    // Mutante: pagar de novo o que o protocolo já creditou aos stakers.
    if (this.sabotage.has('pay-staked-shared')) {
      pool += split.stakedSharedRewards;
    }

    // Mutante: só a primeira página de delegadores.
    const delegators = this.sabotage.has('pagination-truncated')
      ? split.delegators.slice(0, 100)
      : split.delegators;

    const base = split.ownDelegatedBalance + split.externalDelegatedBalance;
    if (base <= 0n) throw new Error('base de delegação é zero — split inválido.');

    const ownShare = (pool * split.ownDelegatedBalance) / base;
    const grossExternal = pool - ownShare;
    const bakerFee = (grossExternal * policy.fee.num) / policy.fee.den;
    const distributable = grossExternal - bakerFee;

    const payments: PlannedPayment[] = [];
    let allocated = 0n;

    for (const d of delegators) {
      const accepted = this.sabotage.has('tz4-rejected')
        ? LEGACY_ADDRESS_RE.test(d.address)
        : validateAddress(d.address) === ValidationResult.VALID;
      if (!accepted) continue;

      let earned = (distributable * d.delegatedBalance) / split.externalDelegatedBalance;

      // Mutante: conversão de valor passando por float.
      if (this.sabotage.has('float-mutez') && earned > 0n) {
        earned = BigInt(Math.floor((Number(earned) / 1e6) * 1e6));
      }

      const carriedIn = policy.carryOver.get(d.address) ?? 0n;
      const payable = earned + carriedIn;
      allocated += earned;

      const floor = this.sabotage.has('no-floor') ? 0n : this.#floorFor(d, policy);
      const paid = payable > floor && payable > 0n;

      payments.push({
        address: d.address,
        earned,
        carriedIn,
        payable,
        amount: paid ? payable : 0n,
        carriedOut: paid ? 0n : payable,
        needsAllocation: d.emptied,
        reason: payable === 0n ? 'zero' : paid ? 'paid' : 'below-floor',
      });
    }

    // Mutante: paga também quem stakeia. O protocolo já creditou o rendimento deles —
    // o batch estaria pagando a mesma coisa duas vezes.
    if (this.sabotage.has('stakers-as-delegators')) {
      for (const st of split.stakers) {
        const earned = (distributable * st.stakedBalance) / (split.externalDelegatedBalance || 1n);
        payments.push({
          address: st.address,
          earned,
          carriedIn: 0n,
          payable: earned,
          amount: earned,
          carriedOut: 0n,
          needsAllocation: false,
          reason: 'paid',
        });
      }
    }

    const dust = distributable - allocated;
    const totalToSend = payments.reduce((acc, p) => acc + p.amount, 0n);

    return { cycle: split.cycle, baker: split.baker, ownShare, bakerFee, dust, payments, totalToSend };
  }

  /**
   * Piso efetivo = `max(piso do baker, custo estimado de pagar este delegador)`.
   * O custo vem da estimativa da própria transferência, não de uma constante:
   * a taxa flutua com a demanda da rede.
   */
  #floorFor(d: { emptied: boolean }, policy: PayoutPolicy): bigint {
    const transferCost = this.batcher.estimatedTransferCost(d.emptied);
    return policy.minPayoutFloor > transferCost ? policy.minPayoutFloor : transferCost;
  }

  async execute(plan: PayoutPlan): Promise<ExecutionResult> {
    return this.batcher.send(plan);
  }
}

/**
 * Oráculo aritmético: recalcula o plano inteiro **do zero**, a partir do split e da
 * política, e compara valor a valor com o que o motor produziu.
 *
 * A primeira versão desta função conferia `own + taxa + Σdevido + sobra == pool` usando
 * a `sobra` que o próprio motor calculou como `distribuível − Σdevido`. Isso é
 * trivialmente verdadeiro por construção: a igualdade fecha com qualquer valor de
 * `devido`, inclusive errado. É exatamente o mesmo defeito do `validateCalculation()`
 * do TAPS, e o selftest pegou — o mutante `float-mutez` passava incólume.
 *
 * A duplicação da fórmula aqui é deliberada: um oráculo que chama o código sob teste
 * não é um oráculo. Esta versão vem do BRES-38 §3.4, não do motor.
 */
export function checkPlanArithmetic(
  split: RewardSplit,
  policy: PayoutPolicy,
  plan: PayoutPlan,
): string | null {
  const pool = split.liquidPool + (policy.includeBlockFees ? split.blockFees : 0n);
  const base = split.ownDelegatedBalance + split.externalDelegatedBalance;
  if (base <= 0n) return 'base de delegação é zero — split inválido.';

  const expectedOwnShare = (pool * split.ownDelegatedBalance) / base;
  const grossExternal = pool - expectedOwnShare;
  const expectedFee = (grossExternal * policy.fee.num) / policy.fee.den;
  const distributable = grossExternal - expectedFee;

  if (plan.ownShare !== expectedOwnShare) {
    return `parte do baker: motor ${plan.ownShare}, esperado ${expectedOwnShare} (diferença ${plan.ownShare - expectedOwnShare}).`;
  }
  if (plan.bakerFee !== expectedFee) {
    return `taxa do baker: motor ${plan.bakerFee}, esperado ${expectedFee} (diferença ${plan.bakerFee - expectedFee}).`;
  }

  const byAddress = new Map(plan.payments.map((p) => [p.address, p]));
  let expectedAllocated = 0n;
  let checked = 0;

  for (const d of split.delegators) {
    const expected = (distributable * d.delegatedBalance) / split.externalDelegatedBalance;
    expectedAllocated += expected;
    const line = byAddress.get(d.address);
    if (!line) continue; // ausência é assunto de `lista-de-delegadores-completa`
    checked++;
    if (line.earned !== expected) {
      return `${d.address}: motor calculou ${line.earned} mutez, a fórmula dá ${expected} (diferença ${line.earned - expected}).`;
    }
    if (line.payable !== line.earned + line.carriedIn) {
      return `${d.address}: devido ${line.payable} != calculado ${line.earned} + acumulado ${line.carriedIn}.`;
    }
    if (line.amount !== 0n && line.amount !== line.payable) {
      return `${d.address}: pagaria ${line.amount}, que não é 0 nem o devido ${line.payable}.`;
    }
    if (line.amount + line.carriedOut !== line.payable) {
      return `${d.address}: pago ${line.amount} + acumulado ${line.carriedOut} != devido ${line.payable} — mutez sumiu ou apareceu.`;
    }
    if (line.earned < 0n || line.amount < 0n || line.carriedOut < 0n) {
      return `${d.address}: valor negativo (devido ${line.earned}, pago ${line.amount}, acumulado ${line.carriedOut}).`;
    }
  }

  if (checked === 0) return 'nenhum delegador do split apareceu no plano.';

  // A sobra é o que resta da divisão inteira, e é do baker. Nunca se inventa mutez.
  const expectedDust = distributable - expectedAllocated;
  if (plan.dust !== expectedDust) {
    return `sobra de arredondamento: motor ${plan.dust}, esperado ${expectedDust} (diferença ${plan.dust - expectedDust}).`;
  }
  if (plan.dust < 0n) return `sobra negativa (${plan.dust}): foram distribuídos mutez que não existiam.`;

  const sent = plan.payments.reduce((a, p) => a + p.amount, 0n);
  if (sent !== plan.totalToSend) return `total a enviar ${plan.totalToSend} != Σ dos pagamentos ${sent}.`;
  if (expectedOwnShare + expectedFee + expectedAllocated + expectedDust !== pool) {
    return `a própria fórmula não fecha contra o pool ${pool} — o split está inconsistente.`;
  }
  return null;
}
