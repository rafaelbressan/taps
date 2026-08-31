/**
 * Auditoria de um ciclo fechado de um baker qualquer — **só leitura**.
 *
 * Existe porque provar a aritmética exige recompensa de verdade, e recompensa de verdade
 * exige um baker que realmente assine blocos. O baker de testes do harness tem direitos,
 * mas não há um daemon `octez-baker` rodando atrás dele: ele vai perder todos os direitos
 * e fechar o ciclo com pool zero. Um pool zero não valida fórmula nenhuma.
 *
 * Então a leitura e o cálculo são conferidos contra um baker de terceiro que **está**
 * bakando na Bakingnet, num ciclo já fechado. Isso exercita, com números reais:
 *
 *   - paginação iterada e validação de campo do split;
 *   - o invariante de completude `Σ delegatedBalance == externalDelegatedBalance`;
 *   - o invariante de poder de baking do BRES-38 §2.6;
 *   - o oráculo aritmético sobre um pool real;
 *   - a exclusão dos stakers, com stakers de verdade no conjunto.
 *
 * Não assina nada e não tem como assinar: não recebe chave nenhuma. Pagar a partir do
 * baker de outra pessoa não é uma operação que exista aqui.
 */
import type { HarnessConfig } from './config.ts';
import { fetchJson } from './chain/http.ts';
import { RpcClient } from './chain/rpc.ts';
import { TzktClient } from './chain/tzkt.ts';
import { ReferenceEngine, checkPlanArithmetic } from './payout/reference-engine.ts';
import { OfflineSender } from './payout/sender.ts';
import { tzktSplit } from './payout/split-source.ts';
import type { PayoutPolicy } from './payout/types.ts';

/**
 * Três estados, e o terceiro importa.
 *
 * `n/a` é para a checagem que **este ciclo não exercitou** — um baker sem staker não
 * prova nem desmente nada sobre stakers. Marcar isso como `passa` seria mentir por
 * omissão: o relatório diria "tudo verde" onde na verdade não houve teste. Marcar como
 * `REPROVA` seria pior ainda, porque treina quem lê a ignorar vermelho.
 */
export type CheckStatus = 'pass' | 'fail' | 'n/a';

export interface AuditCheck {
  name: string;
  status: CheckStatus;
  evidence: string;
}

export interface AuditReport {
  baker: string;
  cycle: number;
  poolMutez: string;
  delegators: number;
  stakers: number;
  stakedSharedMutez: string;
  checks: AuditCheck[];
  /** Quantas checagens este ciclo não exercitou. Verde com `n/a` alto prova pouco. */
  notApplicable: number;
  passed: boolean;
}

export async function audit(
  cfg: HarnessConfig,
  opts: { baker: string; cycle: number; feeNum: bigint; feeDen: bigint; log: (m: string) => void },
): Promise<AuditReport> {
  const rpc = new RpcClient(cfg);
  const tzkt = new TzktClient(cfg);
  await rpc.assertBakingnet();
  const head = await tzkt.assertBakingnet();
  opts.log(`rede: bakingnet, ciclo corrente ${head.cycle}`);

  const constants = await rpc.constants();
  const edge = BigInt(constants.edge_of_staking_over_delegation);

  // Passa pela mesma trava de ciclo e pelo mesmo leitor do caminho de pagamento.
  const split = await tzktSplit(cfg, opts.baker, opts.cycle);
  opts.log(
    `split real: pool ${split.liquidPool} mutez, ${split.delegators.length} delegadores, ` +
      `${split.stakers.length} stakers`,
  );

  const checks: AuditCheck[] = [];
  const add = (name: string, status: CheckStatus, evidence: string): void => {
    checks.push({ name, status, evidence });
  };
  const verdict = (ok: boolean): CheckStatus => (ok ? 'pass' : 'fail');

  // 1) Completude: o invariante que reprova uma lista truncada.
  const sum = split.delegators.reduce((a, d) => a + d.delegatedBalance, 0n);
  add(
    'lista-completa',
    verdict(sum === split.externalDelegatedBalance),
    `Σ delegatedBalance ${sum} vs externalDelegatedBalance ${split.externalDelegatedBalance}`,
  );

  // 2) Poder de baking (BRES-38 §2.6): prova que o modelo econômico foi entendido.
  const raw = await rawSplit(cfg, opts.baker, opts.cycle);
  const ownStaked = BigInt(raw.ownStakedBalance ?? 0);
  const extStaked = BigInt(raw.externalStakedBalance ?? 0);
  const expectedPower =
    ownStaked + extStaked + (split.ownDelegatedBalance + split.externalDelegatedBalance) / edge;
  const reportedPower = BigInt(raw.bakingPower ?? 0);
  add(
    'poder-de-baking',
    verdict(expectedPower === reportedPower),
    `staked ${ownStaked + extStaked} + delegated/${edge} = ${expectedPower} vs bakingPower ${reportedPower}`,
  );

  // 3) Aritmética sobre um pool real.
  const policy: PayoutPolicy = {
    fee: { num: opts.feeNum, den: opts.feeDen },
    includeBlockFees: false,
    minPayoutFloor: 0n,
    carryOver: new Map(),
  };
  const engine = new ReferenceEngine(new OfflineSender());
  const plan = engine.plan(split, policy);
  const problem = checkPlanArithmetic(split, policy, plan);
  add(
    'aritmetica-fecha',
    verdict(problem === null),
    problem ??
      `own ${plan.ownShare} + taxa ${plan.bakerFee} + Σdevido ` +
        `${plan.payments.reduce((a, p) => a + p.earned, 0n)} + sobra ${plan.dust} = ${split.liquidPool}`,
  );

  // 4) Stakers. A primeira versão desta checagem exigia que nenhum staker aparecesse no
  //    batch, e o dado real reprovou — com razão contra mim, não contra o motor: **os três
  //    stakers deste baker também são delegadores**. Um mesmo endereço pode ter saldo
  //    delegado e saldo stakeado com o mesmo baker, e o delegado tem de ser pago.
  //    O que não pode é o rendimento do stake entrar na conta.
  const delegatorAddresses = new Set(split.delegators.map((d) => d.address));
  const stakerOnly = split.stakers.filter((st) => !delegatorAddresses.has(st.address));
  const stakerOnlyPaid = stakerOnly.filter((st) =>
    plan.payments.some((p) => p.address === st.address && p.amount > 0n),
  );
  add(
    'staker-puro-nao-recebe',
    stakerOnly.length === 0 ? 'n/a' : verdict(stakerOnlyPaid.length === 0),
    stakerOnly.length === 0
      ? `os ${split.stakers.length} staker(s) deste ciclo também são delegadores — não há staker puro aqui`
      : `${stakerOnly.length} staker(s) sem saldo delegado, ${stakerOnlyPaid.length} pago(s) indevidamente`,
  );

  // O rendimento de stake nunca entra no pool: é a única coisa que separa pagar
  // corretamente de pagar em dobro.
  add(
    'stake-fora-do-pool',
    split.stakedSharedRewards === 0n
      ? 'n/a'
      : verdict(
          plan.ownShare + plan.bakerFee + distributedEarned(plan) + plan.dust === split.liquidPool,
        ),
    `pool distribuído ${split.liquidPool} mutez; *StakedShared ${split.stakedSharedRewards} mutez ` +
      `ficou de fora (o protocolo já creditou aos stakers — pagar de novo é pagar em dobro)`,
  );

  // Para quem é staker E delegador, o valor pago vem só do saldo delegado.
  const both = split.stakers.filter((st) => delegatorAddresses.has(st.address));
  // A ordem das operações é a do BRES-38 §3.4 e não é decorativa:
  //   taxa = bruto * num // den ; pagável = bruto - taxa
  // Escrever `bruto * (den - num) // den` parece equivalente e não é, porque a divisão é
  // inteira. Com bruto = 7 e taxa de 10 %: a ordem certa dá 7, a "equivalente" dá 6.
  // A primeira versão desta checagem usou a forma errada e reprovou um ciclo real
  // (tz1MbwKSdbL5…/553) — o motor estava certo, a conferência é que estava.
  const grossExternal =
    split.liquidPool -
    (split.liquidPool * split.ownDelegatedBalance) /
      (split.ownDelegatedBalance + split.externalDelegatedBalance);
  const distributableExt = grossExternal - (grossExternal * opts.feeNum) / opts.feeDen;

  const wrong = both.filter((st) => {
    const d = split.delegators.find((x) => x.address === st.address)!;
    const line = plan.payments.find((p) => p.address === st.address);
    const share = (distributableExt * d.delegatedBalance) / split.externalDelegatedBalance;
    return line === undefined || line.earned !== share;
  });
  add(
    'staker-delegador-recebe-so-o-delegado',
    both.length === 0 ? 'n/a' : verdict(wrong.length === 0),
    both.length === 0
      ? 'nenhum endereço acumula stake e delegação neste ciclo — a checagem não prova nada aqui'
      : `${both.length} endereço(s) com stake e delegação; ${wrong.length} com valor derivado de ` +
        `algo além do saldo delegado`,
  );

  // 5) Nenhum mutez inventado nem perdido.
  const distributed = distributedEarned(plan);
  add(
    'nada-excede-o-pool',
    verdict(
      plan.ownShare + plan.bakerFee + distributed + plan.dust === split.liquidPool && plan.dust >= 0n,
    ),
    `sobra ${plan.dust} mutez (>= 0 e o total fecha com o pool)`,
  );

  return {
    baker: opts.baker,
    cycle: opts.cycle,
    poolMutez: split.liquidPool.toString(),
    delegators: split.delegators.length,
    stakers: split.stakers.length,
    stakedSharedMutez: split.stakedSharedRewards.toString(),
    checks,
    notApplicable: checks.filter((c) => c.status === 'n/a').length,
    passed: checks.every((c) => c.status !== 'fail'),
  };
}

function distributedEarned(plan: { payments: { earned: bigint }[] }): bigint {
  return plan.payments.reduce((a, p) => a + p.earned, 0n);
}

async function rawSplit(
  cfg: HarnessConfig,
  baker: string,
  cycle: number,
): Promise<Record<string, number>> {
  const { body } = await fetchJson<Record<string, number>>(
    `${cfg.tzktUrl}/v1/rewards/split/${baker}/${cycle}?limit=0`,
    { timeoutMs: cfg.timeoutMs },
  );
  if (!body) throw new Error(`split vazio para ${baker}/${cycle}`);
  return body;
}

export function renderAudit(r: AuditReport, useColor = process.stdout.isTTY): string {
  const c = (code: string, s: string): string => (useColor ? `${code}${s}\x1b[0m` : s);
  const L = [
    '',
    c('\x1b[1m', `Auditoria — ${r.baker} · ciclo ${r.cycle} · só leitura`),
    c('\x1b[2m', `  pool ${r.poolMutez} mutez · ${r.delegators} delegadores · ${r.stakers} stakers`),
    c('\x1b[2m', `  *StakedShared fora do pool: ${r.stakedSharedMutez} mutez`),
    '',
  ];
  const mark: Record<CheckStatus, string> = {
    pass: c('\x1b[32m', 'passa '),
    fail: c('\x1b[31m', 'REPROVA'),
    'n/a': c('\x1b[33m', 'n/a   '),
  };
  for (const chk of r.checks) {
    L.push(`  ${mark[chk.status]} ${chk.name}`);
    L.push(c('\x1b[2m', `          ${chk.evidence}`));
  }
  L.push('');
  const exercised = r.checks.length - r.notApplicable;
  if (!r.passed) {
    L.push(c('\x1b[31m', `reprovou: ${r.checks.filter((x) => x.status === 'fail').map((x) => x.name).join(', ')}`));
  } else if (r.notApplicable > 0) {
    L.push(
      c('\x1b[32m', `${exercised} de ${r.checks.length} checagens exercitadas, nenhuma reprovou`) +
        c('\x1b[33m', ` — ${r.notApplicable} não se aplicam a este ciclo.`),
    );
  } else {
    L.push(c('\x1b[32m', `${r.checks.length} checagens sobre dado real, nenhuma reprovou.`));
  }
  L.push('');
  return L.join('\n');
}
