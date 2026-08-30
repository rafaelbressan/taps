#!/usr/bin/env node
/**
 * Porta de entrada do harness. Um comando, um diagnóstico legível.
 *
 *   npm run setup                 cria o baker de testes e o coorte em Bakingnet
 *   npm run setup -- --stage baker  registra o delegado, stakeia e delega o coorte
 *   npm run run                   paga de verdade, reconcilia contra a cadeia
 *   npm run run -- --dry-run      só planeja; não injeta nada
 *   npm run selftest              prova que os cenários conseguem reprovar
 *   npm run doctor                confere rede, endpoints e estado do coorte
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { RpcClient } from './chain/rpc.ts';
import { TzktClient } from './chain/tzkt.ts';
import { setup, type SetupStage } from './setup.ts';
import { run } from './run.ts';
import { renderReport } from './report.ts';
import { renderSelftest, selftest } from './selftest.ts';
import { isMutantName, MUTANTS, type MutantName } from './payout/sabotage.ts';
import { loadCohort } from './cohort.ts';

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}
const has = (argv: string[], name: string): boolean => argv.includes(`--${name}`);

async function main(): Promise<number> {
  const [, , command = 'help', ...argv] = process.argv;
  const cfg = loadConfig();

  switch (command) {
    case 'doctor': {
      const rpc = new RpcClient(cfg);
      const tzkt = new TzktClient(cfg);
      const chainId = await rpc.assertBakingnet();
      const head = await tzkt.assertBakingnet();
      const constants = await rpc.constants();
      log(`RPC  ${cfg.rpcUrl} → chain_id ${chainId}`);
      log(`TzKT ${cfg.tzktUrl} → ciclo ${head.cycle}, nível ${head.level}, synced=${head.synced}`);
      log(`constantes: blocks_per_cycle=${constants.blocks_per_cycle} (mainnet é 14400 — o valor pertence à cadeia)`);
      try {
        const cohort = await loadCohort(cfg.stateDir);
        const balance = await rpc.balance(cohort.baker.address);
        log(`baker ${cohort.baker.address}: ${balance} mutez, ${cohort.members.length} membros no coorte`);
        for (const role of ['unallocated', 'tz4', 'dust', 'staker'] as const) {
          const m = cohort.members.find((x) => x.role === role);
          if (m) log(`  ${role}: ${m.address} (alocada: ${await rpc.isAllocated(m.address)})`);
        }
      } catch (err) {
        log(`coorte: ${err instanceof Error ? err.message : String(err)}`);
      }
      return 0;
    }

    case 'setup': {
      const stage = (flag(argv, 'stage') ?? 'accounts') as SetupStage;
      if (!['accounts', 'cohort', 'fund', 'baker', 'delegate'].includes(stage)) {
        log('--stage precisa ser accounts, cohort, fund, baker ou delegate.');
        return 2;
      }
      await setup(cfg, {
        stage,
        bakerFundingTez: Number(flag(argv, 'fund') ?? '8000'),
        seedMutez: BigInt(flag(argv, 'seed') ?? '1000000'),
        log,
      });
      log('setup concluído.');
      return 0;
    }

    case 'run': {
      const mutants = parseMutants(flag(argv, 'sabotage'));
      const report = await run(cfg, {
        split: flag(argv, 'split') ?? `synthetic:${flag(argv, 'pool') ?? '400000000'}`,
        cycle: Number(flag(argv, 'cycle') ?? Math.floor(Date.now() / 1000)),
        mutants,
        dryRun: has(argv, 'dry-run'),
        offline: has(argv, 'offline'),
        log,
      });
      process.stdout.write(renderReport(report));
      await mkdir(cfg.reportDir, { recursive: true });
      const path = join(cfg.reportDir, `run-${report.startedAt.replace(/[:.]/g, '-')}.json`);
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
      log(`relatório em ${path}`);
      // Com mutante ligado, reprovar é o resultado desejado.
      if (mutants.length > 0) return report.passed ? 1 : 0;
      return report.passed ? 0 : 1;
    }

    case 'selftest': {
      const report = await selftest(cfg, {
        poolMutez: BigInt(flag(argv, 'pool') ?? '400000000'),
        baseCycle: Number(flag(argv, 'cycle') ?? Math.floor(Date.now() / 1000)),
        planOnly: has(argv, 'plan-only'),
        offline: has(argv, 'offline'),
        log,
      });
      process.stdout.write(renderSelftest(report));
      await mkdir(cfg.reportDir, { recursive: true });
      await writeFile(
        join(cfg.reportDir, `selftest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      return report.passed ? 0 : 1;
    }

    default:
      process.stdout.write(
        [
          'Harness de QA do TAPS — payout ponta a ponta em Bakingnet.',
          '',
          '  doctor                       confere rede, endpoints e coorte',
          '  setup [--stage accounts|baker] [--fund <XTZ>]',
          '  run [--dry-run] [--pool <mutez>] [--split tzkt:<baker>/<cycle>] [--sabotage <m1,m2>]',
          '  selftest [--plan-only]       prova que os cenários conseguem reprovar',
          '  selftest --offline           idem, sem rede e sem baker provisionado (é o que roda no CI)',
          '',
          'Mutantes disponíveis:',
          ...Object.entries(MUTANTS).map(([k, v]) => `  ${k.padEnd(22)} ${v.label}`),
          '',
        ].join('\n'),
      );
      return 0;
  }
}

function parseMutants(raw: string | undefined): MutantName[] {
  if (!raw) return [];
  const out: MutantName[] = [];
  for (const name of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isMutantName(name)) {
      throw new Error(`mutante desconhecido: ${name}. Conhecidos: ${Object.keys(MUTANTS).join(', ')}`);
    }
    out.push(name);
  }
  return out;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log(`\n${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
