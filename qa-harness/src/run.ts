/**
 * Uma rodada completa do harness: planeja, paga de verdade em Bakingnet, reconcilia
 * contra a cadeia, roda a distribuição de novo, e simula a morte do processo entre
 * a injeção e a confirmação.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TezosToolkit } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
import type { HarnessConfig } from './config.ts';
import { RpcClient } from './chain/rpc.ts';
import { TzktClient } from './chain/tzkt.ts';
import { Journal } from './chain/journal.ts';
import { Batcher } from './chain/batcher.ts';
import { reconcile } from './chain/reconcile.ts';
import { ReferenceEngine } from './payout/reference-engine.ts';
import { Sabotage, type MutantName } from './payout/sabotage.ts';
import { syntheticSplit, tuneDustBalance, tzktSplit } from './payout/split-source.ts';
import type { PayoutPolicy, RewardSplit } from './payout/types.ts';
import { loadCohort, refreshCohort, saveCohort } from './cohort.ts';
import { SCENARIOS, type ScenarioContext, type ScenarioResult } from './scenarios.ts';

export interface RunOptions {
  /** `synthetic:<pool em mutez>` ou `tzkt:<baker>/<cycle>`. */
  split: string;
  cycle: number;
  mutants: MutantName[];
  /** Não injeta nada; só planeja e roda os cenários que não dependem da cadeia. */
  dryRun: boolean;
  log: (msg: string) => void;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  network: { chainId: string; level: number; cycle: number; protocol: string };
  baker: string;
  mutants: MutantName[];
  dryRun: boolean;
  calibration: { transferFeeMutez: string; gasPerTransfer: string; allocationBurnMutez: string };
  plan: {
    cycle: number;
    recipients: number;
    belowFloor: number;
    totalToSendMutez: string;
    ownShareMutez: string;
    bakerFeeMutez: string;
    dustMutez: string;
  };
  onChain: {
    injectedOps: string[];
    secondRunInjectedOps: string[];
    intendedTotalMutez: string;
    onChainTotalMutez: string;
    feesPaidMutez: string;
    allocationFeesPaidMutez: string;
    hashesVerifiedOnRpc: string[];
    notes: string[];
  };
  scenarios: ScenarioResult[];
  passed: boolean;
}

export async function run(cfg: HarnessConfig, opts: RunOptions): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const rpc = new RpcClient(cfg);
  const tzkt = new TzktClient(cfg);

  const chainId = await rpc.assertBakingnet();
  const head = await tzkt.assertBakingnet();
  opts.log(`rede: bakingnet (${chainId}), ciclo ${head.cycle}, nível ${head.level}`);

  const loaded = await loadCohort(cfg.stateDir);
  // Estado de alocação vem da cadeia, não do JSON — e os endereços de borda que já
  // deixaram de ser de borda são trocados antes de qualquer conta ser feita.
  const { cohort, rotated } = await refreshCohort(loaded, (a) => rpc.isAllocated(a), opts.log);
  if (rotated.length > 0) {
    await saveCohort(cfg.stateDir, cohort);
    opts.log(`endereços de borda renovados: ${rotated.join(', ')}`);
  }
  const constants = await rpc.constants();
  opts.log(
    `constantes lidas da cadeia: blocks_per_cycle=${constants.blocks_per_cycle}, ` +
      `hard_gas_limit_per_block=${constants.hard_gas_limit_per_block}, ` +
      `origination_size=${constants.origination_size}, cost_per_byte=${constants.cost_per_byte}`,
  );

  const toolkit = new TezosToolkit(cfg.rpcUrl);
  toolkit.setSignerProvider(new InMemorySigner(cohort.baker.secretKey));

  const journal = new Journal(join(cfg.stateDir, 'journal'));
  const sabotage = new Sabotage(opts.mutants);
  if (!sabotage.isClean) opts.log(`MUTANTES ATIVOS: ${sabotage.names.join(', ')}`);

  const batcher = new Batcher({
    cfg,
    toolkit,
    rpc,
    tzkt,
    constants,
    journal,
    bakerAddress: cohort.baker.address,
    sabotage,
  });

  // O piso é derivado da estimativa da própria rede, não de uma constante.
  const probe = cohort.members.find((m) => !m.emptied)?.address ?? cohort.baker.address;
  const { fee, allocationBurn } = await batcher.calibrate(probe);
  opts.log(
    `calibração: taxa estimada ${fee} mutez, gas ${batcher.gasPerTransfer}, ` +
      `burn de alocação ${allocationBurn} mutez (origination_size × cost_per_byte, da cadeia)`,
  );

  const split = await resolveSplit(cfg, cohort, opts);
  const carryOver = await loadCarryOver(cfg.stateDir);

  // O alvo de poeira sai da taxa medida agora, não de uma constante — e desconta o que
  // já está acumulado, senão o saldo herdado empurra o membro para cima do piso e o
  // cenário deixa de exercitar o caso.
  if (opts.split.startsWith('synthetic:')) {
    const dustMember = cohort.members.find((m) => m.role === 'dust');
    const carriedIn = dustMember ? (carryOver.get(dustMember.address) ?? 0n) : 0n;
    const room = fee - carriedIn;
    tuneDustBalance(split, 10n, 100n, room > 1n ? room / 2n : 1n);
  }
  opts.log(`split: ciclo ${split.cycle}, pool ${split.liquidPool} mutez, ${split.delegators.length} delegadores`);

  const policy: PayoutPolicy = {
    fee: { num: 10n, den: 100n },
    includeBlockFees: false,
    minPayoutFloor: 0n, // piso efetivo = taxa estimada da própria transferência
    carryOver,
  };

  const engine = new ReferenceEngine(batcher, sabotage);
  const plan = engine.plan(split, policy);

  // A outra metade da regra de poeira: acumular sem nunca pagar é o mesmo que não pagar.
  // Replaneja com o saldo do membro de poeira já acima do piso e confere que ele é pago
  // e que o acumulado zera. Custa um replanejamento puro, nenhuma chamada de rede.
  const dustAccumulation = simulateDustPayout(engine, split, policy, cohort, fee, allocationBurn);
  const recipients = plan.payments.filter((p) => p.amount > 0n).length;
  opts.log(
    `plano: ${recipients} a pagar, ${plan.payments.length - recipients} abaixo do piso, ` +
      `${plan.totalToSend} mutez no total`,
  );

  let execution = { injected: [], skipped: [] } as Awaited<ReturnType<typeof engine.execute>>;
  let secondRun = { injected: [], skipped: [] } as typeof execution;
  let crashResume = { injected: 0, refused: false, message: 'não executado (dry-run)' };

  if (!opts.dryRun) {
    opts.log('executando a distribuição na cadeia...');
    execution = await engine.execute(plan);
    opts.log(`injetado: ${execution.injected.map((r) => r.opHash).join(', ') || '(nada)'}`);

    opts.log('executando a MESMA distribuição de novo — a segunda não pode injetar...');
    secondRun = await engine.execute(plan);
    opts.log(`segunda execução: ${secondRun.injected.length} injeções, ${secondRun.skipped.length} puladas`);

    crashResume = await simulateCrashResume(cfg, engine, plan, opts.log);
  }

  const reconciliation = await reconcile(plan, execution, {
    rpc,
    tzkt,
    bakerAddress: cohort.baker.address,
  });

  const ctx: ScenarioContext = {
    dustAccumulation,
    dryRun: opts.dryRun,
    cohort,
    split,
    policy,
    plan,
    execution,
    reconciliation,
    secondRun,
    crashResume,
    transferFee: fee,
    allocationBurn,
  };

  const chainScenarios = new Set([
    'conta-nao-alocada',
    'cadeia-bate-com-a-intencao',
    'idempotencia-execucao-dupla',
    'idempotencia-retomada-apos-morte',
    'acima-de-100-delegadores',
  ]);

  const scenarios = SCENARIOS.filter((s) => !(opts.dryRun && chainScenarios.has(s.name))).map((s) => {
    try {
      return s.check(ctx);
    } catch (err) {
      return { name: s.name, ok: false, evidence: `cenário lançou: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  await saveCarryOver(cfg.stateDir, plan);

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    network: { chainId, level: head.level, cycle: head.cycle, protocol: head.protocol },
    baker: cohort.baker.address,
    mutants: opts.mutants,
    dryRun: opts.dryRun,
    calibration: {
      transferFeeMutez: fee.toString(),
      gasPerTransfer: batcher.gasPerTransfer.toString(),
      allocationBurnMutez: allocationBurn.toString(),
    },
    plan: {
      cycle: plan.cycle,
      recipients,
      belowFloor: plan.payments.filter((p) => p.reason === 'below-floor').length,
      totalToSendMutez: plan.totalToSend.toString(),
      ownShareMutez: plan.ownShare.toString(),
      bakerFeeMutez: plan.bakerFee.toString(),
      dustMutez: plan.dust.toString(),
    },
    onChain: {
      injectedOps: execution.injected.map((r) => r.opHash),
      secondRunInjectedOps: secondRun.injected.map((r) => r.opHash),
      intendedTotalMutez: reconciliation.intendedTotal.toString(),
      onChainTotalMutez: reconciliation.onChainTotal.toString(),
      feesPaidMutez: reconciliation.feesPaid.toString(),
      allocationFeesPaidMutez: reconciliation.allocationFeesPaid.toString(),
      hashesVerifiedOnRpc: reconciliation.hashesVerifiedOnRpc,
      notes: reconciliation.notes,
    },
    scenarios,
    passed: scenarios.every((s) => s.ok),
  };
}

/**
 * Replaneja com o membro de poeira já tendo acumulado acima do piso, e devolve o que
 * aconteceu com ele. É a prova de que o saldo acumulado tem saída — sem ela, "acumula
 * para o ciclo seguinte" é indistinguível de "some".
 */
function simulateDustPayout(
  engine: ReferenceEngine,
  split: RewardSplit,
  policy: PayoutPolicy,
  cohort: Awaited<ReturnType<typeof loadCohort>>,
  fee: bigint,
  allocationBurn: bigint,
): { address: string; seeded: bigint; amount: bigint; carriedOut: bigint } | null {
  const member = cohort.members.find((m) => m.role === 'dust');
  if (!member) return null;
  const floor = fee + (member.emptied ? allocationBurn : 0n);
  const seeded = floor * 4n;
  const carryOver = new Map(policy.carryOver);
  carryOver.set(member.address, seeded);
  const replan = engine.plan(split, { ...policy, carryOver });
  const line = replan.payments.find((p) => p.address === member.address);
  if (!line) return null;
  return { address: member.address, seeded, amount: line.amount, carriedOut: line.carriedOut };
}

/**
 * A variante cruel: mata o processo entre a injeção e a confirmação.
 *
 * Reproduzido de forma fiel ao que fica no disco — o diário é truncado até a linha de
 * intenção, que é exatamente o estado que uma morte naquele instante deixaria. A
 * retomada precisa **recusar**, não repetir: sem `opHash`, ninguém sabe se o dinheiro
 * saiu, e "não sei" nunca autoriza reenviar.
 */
async function simulateCrashResume(
  cfg: HarnessConfig,
  engine: ReferenceEngine,
  plan: Parameters<ReferenceEngine['execute']>[0],
  log: (m: string) => void,
): Promise<{ injected: number; refused: boolean; message: string }> {
  const dir = join(cfg.stateDir, 'journal');
  const key = `${plan.baker}:${plan.cycle}`.replace(/[^\w.-]/g, '_');
  const path = join(dir, `${key}.jsonl`);
  if (!existsSync(path)) return { injected: 0, refused: false, message: 'diário não encontrado' };

  const original = await readFile(path, 'utf8');
  const lines = original.split('\n').filter((l) => l.trim());
  // Guarda só a primeira linha (a intenção, sem opHash) — o retrato de uma morte.
  const truncated = lines.filter((l) => (JSON.parse(l) as { opHash: string }).opHash === '').slice(0, 1);
  if (truncated.length === 0) return { injected: 0, refused: false, message: 'diário sem linha de intenção' };

  log('simulando morte do processo entre injeção e confirmação (diário truncado na intenção)...');
  await writeFile(path, `${truncated.join('\n')}\n`);
  try {
    const result = await engine.execute(plan);
    return { injected: result.injected.length, refused: false, message: 'a retomada não recusou' };
  } catch (err) {
    return { injected: 0, refused: true, message: err instanceof Error ? err.message : String(err) };
  } finally {
    await writeFile(path, original);
  }
}

async function resolveSplit(cfg: HarnessConfig, cohort: Awaited<ReturnType<typeof loadCohort>>, opts: RunOptions): Promise<RewardSplit> {
  if (opts.split.startsWith('tzkt:')) {
    const spec = opts.split.slice('tzkt:'.length);
    const [baker, cycleStr] = spec.split('/');
    if (!baker || !cycleStr) throw new Error('formato esperado: tzkt:<baker>/<cycle>');
    return tzktSplit(cfg, baker, Number(cycleStr));
  }
  if (opts.split.startsWith('synthetic:')) {
    const pool = BigInt(opts.split.slice('synthetic:'.length));
    return syntheticSplit(cohort, opts.cycle, pool);
  }
  throw new Error(`fonte de split desconhecida: ${opts.split}`);
}

async function loadCarryOver(stateDir: string): Promise<Map<string, bigint>> {
  const path = join(stateDir, 'carry-over.json');
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
  return new Map(Object.entries(raw).map(([k, v]) => [k, BigInt(v)]));
}

async function saveCarryOver(stateDir: string, plan: { payments: { address: string; carriedOut: bigint }[] }): Promise<void> {
  const out: Record<string, string> = {};
  for (const p of plan.payments) {
    if (p.carriedOut > 0n) out[p.address] = p.carriedOut.toString();
  }
  await writeFile(join(stateDir, 'carry-over.json'), `${JSON.stringify(out, null, 2)}\n`);
}
