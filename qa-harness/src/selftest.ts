/**
 * A prova de que os cenários conseguem reprovar.
 *
 * Para cada mutante: liga o mutante, roda o harness, e **exige que reprove**.
 * Um mutante que sobrevive significa que o cenário responsável por ele é decorativo,
 * e o selftest diz isso com o nome do cenário.
 *
 * Este é o teste do teste. Sem ele, "os cenários passaram" não quer dizer nada:
 * `validateCalculation()` do TAPS atual também passa, e é trivialmente verdadeira.
 */
import type { HarnessConfig } from './config.ts';
import { MUTANTS, type MutantName } from './payout/sabotage.ts';
import { run, type RunReport } from './run.ts';
import { SCENARIOS } from './scenarios.ts';

/** Mutantes cujo efeito só aparece quando o dinheiro se move de verdade. */
const CHAIN_MUTANTS: MutantName[] = ['idempotency', 'storage-limit', 'batch-cap'];

export interface MutantVerdict {
  mutant: MutantName;
  label: string;
  /** `true` quando o harness reprovou — que é o resultado desejado. */
  caught: boolean;
  /** Cenário que deveria pegá-lo, segundo o catálogo. */
  expectedScenario: string;
  /** Cenários que de fato reprovaram. */
  failedScenarios: string[];
  /** A evidência de cada reprovação — é aqui que ficam os hashes das operações. */
  failedEvidence: string[];
  /** Reprovou pelo cenário certo, e não por acidente de outro. */
  caughtByExpected: boolean;
  detail: string;
}

export interface SelftestReport {
  baselinePassed: boolean;
  baselineDetail: string;
  verdicts: MutantVerdict[];
  /** Cenários que nenhum mutante fez reprovar. */
  scenariosNeverExercised: string[];
  passed: boolean;
}

export interface SelftestOptions {
  /** Pool sintético por rodada, em mutez. */
  poolMutez: bigint;
  /** Ciclo base; cada rodada usa um ciclo distinto para ter diário próprio. */
  baseCycle: number;
  /** Pula os mutantes que exigem injeção real. Mais rápido, prova menos. */
  planOnly: boolean;
  log: (msg: string) => void;
}

export async function selftest(cfg: HarnessConfig, opts: SelftestOptions): Promise<SelftestReport> {
  const verdicts: MutantVerdict[] = [];
  let cycle = opts.baseCycle;

  // Linha de base: sem mutante, tudo tem que passar. Se a base reprova, os veredictos
  // dos mutantes não significam nada — estariam reprovando pelo motivo errado.
  opts.log('linha de base (sem mutante)...');
  const baseline = await run(cfg, {
    split: `synthetic:${opts.poolMutez}`,
    cycle: cycle++,
    mutants: [],
    dryRun: opts.planOnly,
    log: (m) => opts.log(`  ${m}`),
  });
  const baselineFailed = baseline.scenarios.filter((s) => !s.ok).map((s) => s.name);
  if (!baseline.passed) {
    return {
      baselinePassed: false,
      baselineDetail: `a linha de base reprovou em: ${baselineFailed.join(', ')}. Conserte isso antes de ler os mutantes.`,
      verdicts: [],
      scenariosNeverExercised: [],
      passed: false,
    };
  }

  const names = (Object.keys(MUTANTS) as MutantName[]).filter(
    (m) => !opts.planOnly || !CHAIN_MUTANTS.includes(m),
  );

  for (const mutant of names) {
    const meta = MUTANTS[mutant];
    opts.log(`mutante "${mutant}" (${meta.label})...`);
    let report: RunReport | undefined;
    let thrown: string | undefined;
    try {
      report = await run(cfg, {
        split: `synthetic:${opts.poolMutez}`,
        cycle: cycle++,
        mutants: [mutant],
        dryRun: opts.planOnly || !CHAIN_MUTANTS.includes(mutant),
        log: () => {},
      });
    } catch (err) {
      // Explodir também é reprovar — desde que explique. O que não pode é passar.
      thrown = err instanceof Error ? err.message : String(err);
    }

    const failedScenarios = report ? report.scenarios.filter((s) => !s.ok).map((s) => s.name) : [];
    const caught = thrown !== undefined || (report !== undefined && !report.passed);
    const caughtByExpected = thrown !== undefined || failedScenarios.includes(meta.caughtBy);

    verdicts.push({
      mutant,
      label: meta.label,
      caught,
      expectedScenario: meta.caughtBy,
      failedScenarios,
      failedEvidence: report ? report.scenarios.filter((sc) => !sc.ok).map((sc) => `${sc.name}: ${sc.evidence}`) : [],
      caughtByExpected,
      detail: thrown
        ? `reprovou por exceção: ${thrown.split('\n')[0]!.slice(0, 180)}`
        : caught
          ? `reprovou em: ${failedScenarios.join(', ')}`
          : 'PASSOU — o cenário que deveria pegá-lo não pega nada.',
    });
    opts.log(`  ${caught ? 'reprovou (correto)' : 'PASSOU — mutante sobreviveu'}`);
  }

  const exercised = new Set(verdicts.flatMap((v) => v.failedScenarios));
  const considered = opts.planOnly
    ? SCENARIOS.filter((s) => s.catches.every((m) => !CHAIN_MUTANTS.includes(m)))
    : SCENARIOS;
  const scenariosNeverExercised = considered.filter((s) => !exercised.has(s.name)).map((s) => s.name);

  return {
    baselinePassed: true,
    baselineDetail: `${baseline.scenarios.length} cenários passaram sem mutante.`,
    verdicts,
    scenariosNeverExercised,
    passed: verdicts.every((v) => v.caught && v.caughtByExpected),
  };
}

export function renderSelftest(r: SelftestReport, useColor = process.stdout.isTTY): string {
  const c = (code: string, s: string) => (useColor ? `${code}${s}\x1b[0m` : s);
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';

  const L: string[] = ['', c(BOLD, 'Selftest — os cenários conseguem reprovar?'), ''];
  L.push(`  linha de base: ${r.baselinePassed ? c(GREEN, 'passa') : c(RED, 'REPROVA')} ${c(DIM, r.baselineDetail)}`);
  L.push('');

  for (const v of r.verdicts) {
    const mark = v.caught && v.caughtByExpected ? c(GREEN, 'pego  ') : c(RED, 'SOBREVIVEU');
    L.push(`  ${mark} ${v.mutant} ${c(DIM, `— ${v.label}`)}`);
    L.push(c(DIM, `          esperado por: ${v.expectedScenario}`));
    L.push(c(DIM, `          ${v.detail}`));
  }
  L.push('');

  if (r.scenariosNeverExercised.length > 0) {
    L.push(
      c(RED, `cenários que nenhum mutante fez reprovar: ${r.scenariosNeverExercised.join(', ')}`),
    );
    L.push(c(DIM, 'Um cenário nessa lista não prova nada. Ou falta um mutante, ou o cenário é decorativo.'));
    L.push('');
  }

  const survivors = r.verdicts.filter((v) => !v.caught || !v.caughtByExpected);
  L.push(
    r.passed
      ? c(GREEN, `${r.verdicts.length} mutantes, todos pegos pelo cenário certo.`)
      : c(RED, `${survivors.length} de ${r.verdicts.length} mutantes sobreviveram: ${survivors.map((v) => v.mutant).join(', ')}`),
  );
  L.push('');
  return L.join('\n');
}
