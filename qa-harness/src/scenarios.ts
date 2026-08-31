/**
 * Os cenários nomeados. Cada caso de borda da BRES-44 tem um nome aqui, e cada nome
 * declara qual mutante ele precisa pegar — é isso que o `selftest` cobra.
 *
 * Um cenário que nenhum mutante faz reprovar é decorativo, e o `selftest` diz isso
 * em voz alta em vez de deixar passar.
 */
import { validateAddress, ValidationResult } from '@taquito/utils';
import type { MutantName } from './payout/sabotage.ts';
import type { PayoutPlan, PayoutPolicy, RewardSplit, ExecutionResult } from './payout/types.ts';
import type { Reconciliation } from './chain/reconcile.ts';
import { checkPlanArithmetic } from './payout/reference-engine.ts';
import type { Cohort } from './cohort.ts';

export interface ScenarioContext {
  /** Ensaio: o plano existe, mas nada foi injetado. Asserções sobre a cadeia não valem. */
  dryRun: boolean;
  /** Replanejamento com o membro de poeira já acumulado acima do piso. */
  dustAccumulation: { address: string; seeded: bigint; amount: bigint; carriedOut: bigint } | null;
  cohort: Cohort;
  split: RewardSplit;
  policy: PayoutPolicy;
  plan: PayoutPlan;
  execution: ExecutionResult;
  reconciliation: Reconciliation;
  /** Resultado da segunda execução idêntica. Vazio em `injected` é o que se espera. */
  secondRun: ExecutionResult;
  /** Resultado da retomada após morte simulada entre injeção e confirmação. */
  crashResume: { injected: number; refused: boolean; message: string };
  transferFee: bigint;
  allocationBurn: bigint;
}

/**
 * Três estados. `n/a` é para o cenário que **esta rodada não exercitou** — rodar contra o
 * split real de outro baker não põe o endereço tz4 do coorte em lugar nenhum, e cobrar
 * isso como reprovação é ruído. Marcar como `passa` seria pior: o relatório diria verde
 * onde não houve teste. A lição veio do `audit`, que cometeu os dois erros antes.
 */
export type ScenarioStatus = 'pass' | 'fail' | 'n/a';

export interface ScenarioResult {
  name: string;
  status: ScenarioStatus;
  /** Conveniência de leitura: `n/a` não é reprovação. */
  ok: boolean;
  /** O que se observou. Uma linha, com número. */
  evidence: string;
}

export interface Scenario {
  name: string;
  /** O que este cenário afirma. */
  asserts: string;
  /** Mutantes que precisam fazer este cenário reprovar. */
  catches: MutantName[];
  check(ctx: ScenarioContext): ScenarioResult;
}

const ok = (name: string, evidence: string): ScenarioResult =>
  ({ name, status: 'pass', ok: true, evidence });
const fail = (name: string, evidence: string): ScenarioResult =>
  ({ name, status: 'fail', ok: false, evidence });
/** Não exercitado nesta rodada. Não é reprovação e não conta como prova. */
const na = (name: string, why: string): ScenarioResult =>
  ({ name, status: 'n/a', ok: true, evidence: why });

/**
 * Quanto sobra para os delegadores, recalculado do split — na ordem do BRES-38 §3.4.
 * `taxa = bruto × num ÷ den` e `pagável = bruto − taxa`; escrever
 * `bruto × (den − num) ÷ den` **não** é equivalente, porque a divisão é inteira.
 */
function expectedDistributable(ctx: ScenarioContext): bigint {
  const pool = ctx.split.liquidPool + (ctx.policy.includeBlockFees ? ctx.split.blockFees : 0n);
  const base = ctx.split.ownDelegatedBalance + ctx.split.externalDelegatedBalance;
  if (base <= 0n) return 0n;
  const grossExternal = pool - (pool * ctx.split.ownDelegatedBalance) / base;
  return grossExternal - (grossExternal * ctx.policy.fee.num) / ctx.policy.fee.den;
}

/** O membro do coorte está neste split? Rodando contra split de terceiro, não está. */
function inSplit(ctx: ScenarioContext, address: string): boolean {
  return ctx.split.delegators.some((d) => d.address === address);
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'aritmetica-fecha',
    asserts:
      'ownShare + taxa + Σ devido + sobra == pool; nenhum valor negativo; nada excede o pool',
    catches: ['float-mutez', 'pay-staked-shared'],
    check(ctx) {
      const problem = checkPlanArithmetic(ctx.split, ctx.policy, ctx.plan);
      if (problem) return fail(this.name, problem);
      return ok(
        this.name,
        `pool ${ctx.split.liquidPool} = own ${ctx.plan.ownShare} + taxa ${ctx.plan.bakerFee} + ` +
          `Σdevido ${ctx.plan.payments.reduce((a, p) => a + p.earned, 0n)} + sobra ${ctx.plan.dust}`,
      );
    },
  },
  {
    name: 'lista-de-delegadores-completa',
    asserts: 'todo delegador do split entra no plano; Σ saldos == externalDelegatedBalance',
    catches: ['pagination-truncated', 'tz4-rejected'],
    check(ctx) {
      const sum = ctx.split.delegators.reduce((a, d) => a + d.delegatedBalance, 0n);
      if (sum !== ctx.split.externalDelegatedBalance) {
        return fail(
          this.name,
          `Σ delegatedBalance ${sum} != externalDelegatedBalance ${ctx.split.externalDelegatedBalance}`,
        );
      }
      const planned = new Set(ctx.plan.payments.map((p) => p.address));
      const dropped = ctx.split.delegators.filter((d) => !planned.has(d.address));
      if (dropped.length > 0) {
        return fail(
          this.name,
          `${dropped.length} de ${ctx.split.delegators.length} delegadores sumiram do plano ` +
            `(ex.: ${dropped[0]!.address}) — em silêncio, sem erro.`,
        );
      }
      return ok(this.name, `${ctx.plan.payments.length} de ${ctx.split.delegators.length} delegadores no plano`);
    },
  },
  {
    name: 'conta-nao-alocada',
    asserts: 'um destinatário nunca alocado recebe, e não derruba o lote dos outros',
    catches: ['storage-limit'],
    check(ctx) {
      const member = ctx.cohort.members.find((m) => m.role === 'unallocated');
      if (!member) return fail(this.name, 'coorte sem membro `unallocated` — o caso de borda sumiu do coorte.');
      if (!inSplit(ctx, member.address)) {
        return na(this.name, 'o split desta rodada não é o do coorte; não há conta não alocada para exercitar');
      }
      const planned = ctx.plan.payments.find((p) => p.address === member.address);
      if (!planned || planned.amount === 0n) {
        return fail(this.name, `${member.address} não recebeu valor no plano.`);
      }
      const onChain = ctx.reconciliation.missing.find((m) => m.address === member.address);
      if (onChain) {
        return fail(
          this.name,
          `${member.address} estava no plano com ${planned.amount} mutez e recebeu 0 na cadeia — ` +
            `é exatamente aqui que o storage_limit fixo em 0 derruba o lote.`,
        );
      }
      if (!ctx.reconciliation.ok) {
        return fail(
          this.name,
          `o lote que contém a conta não alocada não fechou: ${ctx.reconciliation.missing.length} ` +
            `destinatários sem receber, ${ctx.reconciliation.mismatches.length} com valor diferente.`,
        );
      }
      return ok(
        this.name,
        `${member.address} recebeu ${planned.amount} mutez; burn de alocação total ` +
          `${ctx.reconciliation.allocationFeesPaid} mutez`,
      );
    },
  },
  {
    name: 'delegador-tz4',
    asserts: 'um delegador com endereço tz4 (BLS) é aceito e pago',
    catches: ['tz4-rejected'],
    check(ctx) {
      const member = ctx.cohort.members.find((m) => m.role === 'tz4');
      if (!member) return fail(this.name, 'coorte sem membro tz4.');
      if (!inSplit(ctx, member.address)) {
        return na(this.name, 'o split desta rodada não é o do coorte; nenhum endereço tz4 no conjunto');
      }
      if (validateAddress(member.address) !== ValidationResult.VALID) {
        return fail(this.name, `${member.address} não é um endereço válido — coorte mal gerado.`);
      }
      const planned = ctx.plan.payments.find((p) => p.address === member.address);
      if (!planned) {
        return fail(
          this.name,
          `${member.address} foi descartado antes do plano. Endereço tz4 é rejeitado por validação ` +
            `client-side; a cadeia cobra o mesmo gas de um tz1.`,
        );
      }
      if (planned.amount === 0n) {
        return fail(
          this.name,
          `${member.address} entrou no plano com valor 0. Se a causa for o piso, aumente o pool: ` +
            `uma conta tz4 nova custa taxa + burn de alocação para ser paga.`,
        );
      }
      if (ctx.dryRun) return ok(this.name, `${member.address} no plano com ${planned.amount} mutez (ensaio)`);
      const missing = ctx.reconciliation.missing.some((m) => m.address === member.address);
      if (missing) return fail(this.name, `${member.address} não recebeu na cadeia.`);
      return ok(this.name, `${member.address} recebeu ${planned.amount} mutez`);
    },
  },
  {
    name: 'acima-de-100-delegadores',
    asserts: 'mais de 100 destinatários são pagos, dividindo o lote pelo gas do bloco',
    catches: ['batch-cap'],
    check(ctx) {
      const paid = ctx.plan.payments.filter((p) => p.amount > 0n);
      if (ctx.split.delegators.length <= 100) {
        return na(
          this.name,
          `o split desta rodada tem ${ctx.split.delegators.length} delegadores; ` +
            `não dá para exercitar o limite de 100`,
        );
      }
      if (paid.length <= 100) {
        const belowFloor = ctx.plan.payments.filter((p) => p.reason === 'below-floor').length;
        return fail(
          this.name,
          `só ${paid.length} destinatários acima do piso (${belowFloor} abaixo) — este cenário ` +
            `precisa de mais de 100 para significar alguma coisa. Numa rodada com contas novas o ` +
            `piso inclui o burn de alocação (${ctx.allocationBurn} mutez): o pool precisa passar de ` +
            `~100 × esse valor.`,
        );
      }
      const missing = ctx.reconciliation.missing.length;
      if (missing > 0) {
        return fail(
          this.name,
          `${paid.length} destinatários planejados, ${missing} não receberam nada na cadeia — ` +
            `o lote foi cortado.`,
        );
      }
      return ok(
        this.name,
        `${paid.length} destinatários pagos em ${ctx.execution.injected.length} operação(ões)`,
      );
    },
  },
  {
    name: 'valor-de-poeira',
    asserts:
      'quem recebe menos que o custo de pagá-lo não é pago e o valor acumula; e o acumulado é pago quando passa do piso',
    catches: ['no-floor'],
    check(ctx) {
      const member = ctx.cohort.members.find((m) => m.role === 'dust');
      if (!member) return fail(this.name, 'coorte sem membro `dust`.');
      if (!inSplit(ctx, member.address)) {
        return na(this.name, 'o split desta rodada não é o do coorte; nenhum valor de poeira plantado');
      }
      const planned = ctx.plan.payments.find((p) => p.address === member.address);
      if (!planned) return fail(this.name, `${member.address} sumiu do plano.`);

      const floor = ctx.transferFee + (member.emptied ? ctx.allocationBurn : 0n);
      if (planned.payable > floor) {
        return fail(
          this.name,
          `${member.address} deve ${planned.payable} mutez, acima do piso ${floor} — ` +
            `este membro parou de produzir poeira; o coorte precisa ser reajustado.`,
        );
      }
      if (planned.amount !== 0n) {
        return fail(
          this.name,
          `${member.address} recebeu ${planned.amount} mutez custando ${floor} para ser pago — ` +
            `pagar poeira gasta mais do que entrega.`,
        );
      }
      if (planned.carriedOut !== planned.payable) {
        return fail(
          this.name,
          `${member.address} não foi pago mas o valor não acumulou ` +
            `(acumulado ${planned.carriedOut} != devido ${planned.payable}).`,
        );
      }

      // Metade dois: acumular e nunca pagar é o mesmo que não pagar.
      const acc = ctx.dustAccumulation;
      if (!acc) return fail(this.name, 'não foi possível simular o acumulado acima do piso.');
      if (acc.amount <= 0n) {
        return fail(
          this.name,
          `com ${acc.seeded} mutez acumulados (piso ${floor}), ${acc.address} continuaria sem receber — ` +
            `o saldo acumularia para sempre, que é o mesmo que não pagar.`,
        );
      }
      if (acc.carriedOut !== 0n) {
        return fail(
          this.name,
          `${acc.address} foi pago ${acc.amount} mas ainda sobrou ${acc.carriedOut} acumulado — ` +
            `o pagamento precisa zerar a dívida.`,
        );
      }

      return ok(
        this.name,
        `${member.address}: devido ${planned.payable} <= piso ${floor}, acumulou ${planned.carriedOut}; ` +
          `com ${acc.seeded} acumulados seria pago ${acc.amount} e a dívida zeraria`,
      );
    },
  },
  {
    name: 'staker-nao-recebe-por-fora',
    asserts:
      'nenhum endereço recebe por conta do saldo stakeado; quem também delega recebe só pelo delegado',
    catches: ['stakers-as-delegators'],
    check(ctx) {
      if (ctx.split.stakers.length === 0) {
        return na(
          this.name,
          'o split desta rodada não tem staker; sem staker no conjunto o cenário não prova nada',
        );
      }

      // A regra não é "staker fica fora do batch". Um mesmo endereço pode ter saldo
      // delegado e saldo stakeado com o mesmo baker — nos bakers reais da Bakingnet é o
      // caso comum —, e o saldo delegado **tem** de ser pago. O que não pode entrar na
      // conta é o rendimento do stake, que o protocolo já creditou.
      const distributable = expectedDistributable(ctx);
      const offenders: string[] = [];
      let excess = 0n;

      for (const st of ctx.split.stakers) {
        const delegated = ctx.split.delegators.find((d) => d.address === st.address);
        const expected =
          delegated === undefined
            ? 0n
            : (distributable * delegated.delegatedBalance) / ctx.split.externalDelegatedBalance;
        const got = ctx.plan.payments
          .filter((p) => p.address === st.address)
          .reduce((a, p) => a + p.amount, 0n);
        if (got > expected) {
          offenders.push(st.address);
          excess += got - expected;
        }
      }

      if (offenders.length > 0) {
        return fail(
          this.name,
          `${offenders.length} staker(s) receberiam ${excess} mutez a mais do que o saldo ` +
            `delegado justifica — pagamento duplicado: o rendimento de stake ` +
            `(${ctx.split.stakedSharedRewards} mutez em *StakedShared) já foi creditado pelo ` +
            `protocolo. Ex.: ${offenders[0]}.`,
        );
      }

      const alsoDelegators = ctx.split.stakers.filter((st) =>
        ctx.split.delegators.some((d) => d.address === st.address),
      ).length;
      return ok(
        this.name,
        `${ctx.split.stakers.length} staker(s), ${alsoDelegators} deles também delegadores; ` +
          `ninguém recebeu além do saldo delegado. ${ctx.split.stakedSharedRewards} mutez de ` +
          `*StakedShared ficaram fora do pool`,
      );
    },
  },
  {
    name: 'cadeia-bate-com-a-intencao',
    asserts: 'mutez a mutez, o que a cadeia pagou == o que o sistema disse que ia pagar',
    catches: ['storage-limit', 'batch-cap', 'float-mutez'],
    check(ctx) {
      const r = ctx.reconciliation;
      if (!r.ok) {
        const lines = [
          `${r.missing.length} não receberam, ${r.mismatches.length} com valor diferente, ` +
            `${r.unexpected.length} inesperados.`,
          ...r.missing.slice(0, 3).map((m) => `  faltou ${m.address}: esperado ${m.intended}, na cadeia 0`),
          ...r.mismatches.slice(0, 3).map((m) => `  divergiu ${m.address}: esperado ${m.intended}, na cadeia ${m.onChain}`),
        ];
        return fail(this.name, lines.join('\n'));
      }
      if (r.hashesVerifiedOnRpc.length === 0 && ctx.execution.injected.length > 0) {
        return fail(this.name, 'nenhum hash foi confirmado pela RPC — a conferência dependeu só do indexador.');
      }
      return ok(
        this.name,
        `${r.onChainTotal} mutez pagos == ${r.intendedTotal} planejados; ` +
          `${r.hashesVerifiedOnRpc.length} hash(es) confirmado(s) também pela RPC; ` +
          `taxa ${r.feesPaid} + alocação ${r.allocationFeesPaid} mutez`,
      );
    },
  },
  {
    name: 'idempotencia-execucao-dupla',
    asserts: 'a mesma distribuição rodada duas vezes injeta na primeira e não injeta na segunda',
    catches: ['idempotency'],
    check(ctx) {
      if (ctx.execution.injected.length === 0) {
        return fail(this.name, 'a primeira execução não injetou nada — não há o que provar.');
      }
      if (ctx.secondRun.injected.length > 0) {
        const total = ctx.secondRun.injected.flatMap((r) => r.amounts).reduce((a, b) => a + BigInt(b), 0n);
        return fail(
          this.name,
          `a segunda execução injetou ${ctx.secondRun.injected.length} operação(ões), ` +
            `${total} mutez pagos de novo. Hashes: ${ctx.secondRun.injected.map((r) => r.opHash).join(', ')}`,
        );
      }
      return ok(
        this.name,
        `1ª execução: ${ctx.execution.injected.length} operação(ões); ` +
          `2ª execução: 0 injeções, ${ctx.secondRun.skipped.length} registros reconhecidos no diário`,
      );
    },
  },
  {
    name: 'idempotencia-retomada-apos-morte',
    asserts:
      'com o diário mostrando intenção sem confirmação, a retomada recusa em vez de pagar de novo',
    catches: ['idempotency'],
    check(ctx) {
      if (ctx.crashResume.injected > 0) {
        return fail(
          this.name,
          `a retomada injetou ${ctx.crashResume.injected} operação(ões) sobre um estado ` +
            `"não sei se pagou". É assim que se paga duas vezes.`,
        );
      }
      if (!ctx.crashResume.refused) {
        return fail(
          this.name,
          'a retomada não injetou, mas também não reclamou — silêncio sobre estado indeterminado ' +
            'esconde o problema em vez de escalar.',
        );
      }
      return ok(this.name, `recusou e explicou: ${firstLine(ctx.crashResume.message)}`);
    },
  },
];

function firstLine(s: string): string {
  return s.split('\n')[0]!.slice(0, 160);
}
