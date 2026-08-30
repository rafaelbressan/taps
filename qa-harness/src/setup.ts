/**
 * Cria o baker de testes e o coorte de delegadores em Bakingnet, do zero.
 *
 * Duas etapas, separadas de propósito porque têm escalas de tempo diferentes:
 *
 *   `accounts` — segundos a minutos. Gera as chaves, saca do faucet, e aloca **só** as
 *                contas que devem estar alocadas. As contas de borda ficam sem alocar
 *                de propósito: é a ausência delas na cadeia que é o caso de teste.
 *
 *   `baker`    — horas. Registra o delegado, stakeia o mínimo, e delega o coorte.
 *                Direitos de consenso só existem depois de `consensus_rights_delay`
 *                ciclos, e recompensa fechada só depois disso. Em Bakingnet um ciclo
 *                é 3600 blocos × 6 s = 6 h. Ninguém acelera isso.
 *
 * A etapa `accounts` já basta para tudo que o harness verifica sobre movimentação de
 * dinheiro. A etapa `baker` é o que faz aparecer um `rewards/split` real.
 */
import { OpKind, TezosToolkit } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
import type { HarnessConfig } from './config.ts';
import { RpcClient } from './chain/rpc.ts';
import { TzktClient } from './chain/tzkt.ts';
import { Faucet } from './faucet.ts';
import { buildCohort, generateEd25519, loadCohort, saveCohort, type Cohort } from './cohort.ts';
import { mapLimit } from './chain/http.ts';

export type SetupStage = 'accounts' | 'cohort' | 'fund' | 'baker' | 'delegate';

export interface SetupOptions {
  stage: SetupStage;
  /** Quanto o baker saca do faucet, em XTZ. */
  bakerFundingTez: number;
  /** Saldo semeado em cada conta que deve estar alocada, em mutez. */
  seedMutez: bigint;
  log: (msg: string) => void;
}

export async function setup(cfg: HarnessConfig, opts: SetupOptions): Promise<Cohort> {
  const rpc = new RpcClient(cfg);
  const tzkt = new TzktClient(cfg);

  // Trava de rede antes de qualquer coisa que gaste ou gere chave.
  const chainId = await rpc.assertBakingnet();
  const head = await tzkt.assertBakingnet();
  opts.log(`rede conferida: chain_id ${chainId}, ciclo ${head.cycle}, nível ${head.level}`);

  if (opts.stage === 'accounts') return setupAccounts(cfg, rpc, opts);
  if (opts.stage === 'cohort') return setupCohort(cfg, rpc, opts);
  if (opts.stage === 'fund') return topUpBaker(cfg, rpc, opts);
  if (opts.stage === 'delegate') return delegateCohort(cfg, opts);
  return setupBaker(cfg, rpc, opts);
}

async function setupAccounts(cfg: HarnessConfig, rpc: RpcClient, opts: SetupOptions): Promise<Cohort> {
  const faucet = new Faucet(cfg);
  const info = await faucet.info();
  if (opts.bakerFundingTez > info.maxTez) {
    throw new Error(`faucet entrega no máximo ${info.maxTez} XTZ por saque.`);
  }

  const bakerKey = await generateEd25519();
  opts.log(`baker de testes: ${bakerKey.address}`);

  const txHash = await faucet.fund(bakerKey.address, opts.bakerFundingTez, opts.log);
  opts.log(`faucet enviou ${opts.bakerFundingTez} XTZ — ${txHash}`);

  const cohort = await buildCohort(bakerKey.secretKey);
  const path = await saveCohort(cfg.stateDir, cohort);
  opts.log(`coorte com ${cohort.members.length} membros salvo em ${path}`);

  await waitForBalance(rpc, bakerKey.address, opts.log);
  return allocateSeedAccounts(cfg, rpc, cohort, opts);
}

/**
 * Aloca só quem deve estar alocado. `unallocated` e `tz4` ficam de fora **de propósito**:
 * a ausência deles na cadeia é o caso de teste, e é ela que o `storageLimit: 0` derruba.
 */
async function allocateSeedAccounts(
  cfg: HarnessConfig,
  rpc: RpcClient,
  cohort: Cohort,
  opts: SetupOptions,
): Promise<Cohort> {
  const toolkit = new TezosToolkit(cfg.rpcUrl);
  toolkit.setSignerProvider(new InMemorySigner(cohort.baker.secretKey));
  const constants = await rpc.constants();

  const toAllocate = cohort.members.filter((m) => !m.emptied);
  opts.log(
    `alocando ${toAllocate.length} contas; ${cohort.members.length - toAllocate.length} ficam sem alocar de propósito`,
  );
  if (toAllocate.length === 0) return cohort;

  const transfers = toAllocate.map((m) => ({
    kind: OpKind.TRANSACTION as const,
    to: m.address,
    amount: Number(opts.seedMutez),
    mutez: true,
    storageLimit: constants.origination_size,
  }));
  const op = await toolkit.contract.batch(transfers).send();
  opts.log(`alocação injetada: ${op.hash}`);
  await op.confirmation(2);
  opts.log('alocação confirmada.');
  return cohort;
}

/**
 * Gera um coorte novo mantendo o baker existente. Serve para renovar os casos de borda
 * sem gastar os minutos de prova de trabalho do faucet de novo.
 */
async function setupCohort(cfg: HarnessConfig, rpc: RpcClient, opts: SetupOptions): Promise<Cohort> {
  const previous = await loadCohort(cfg.stateDir);
  const cohort = await buildCohort(previous.baker.secretKey);
  await saveCohort(cfg.stateDir, cohort);
  opts.log(`coorte novo com ${cohort.members.length} membros para o baker ${cohort.baker.address}`);
  return allocateSeedAccounts(cfg, rpc, cohort, opts);
}

async function setupBaker(cfg: HarnessConfig, rpc: RpcClient, opts: SetupOptions): Promise<Cohort> {
  const cohort = await loadCohort(cfg.stateDir);
  const constants = await rpc.constants();
  const minimalStake = BigInt(constants.minimal_stake);

  const toolkit = new TezosToolkit(cfg.rpcUrl);
  toolkit.setSignerProvider(new InMemorySigner(cohort.baker.secretKey));

  const balance = await rpc.balance(cohort.baker.address);
  opts.log(`saldo do baker: ${balance} mutez; minimal_stake lido da cadeia: ${minimalStake}`);
  if (balance < minimalStake) {
    throw new Error(
      `o baker precisa de pelo menos ${minimalStake} mutez para ter poder de baking; ` +
        `tem ${balance}. Saque mais do faucet antes de rodar esta etapa.`,
    );
  }

  opts.log('registrando o delegado (setDelegate para si mesmo)...');
  const reg = await toolkit.contract.setDelegate({
    source: cohort.baker.address,
    delegate: cohort.baker.address,
  });
  await reg.confirmation(2);
  opts.log(`delegado registrado: ${reg.hash}`);

  opts.log(`stakeando ${minimalStake} mutez...`);
  const stake = await toolkit.wallet.stake({ amount: Number(minimalStake), mutez: true }).send();
  await stake.confirmation(2);
  opts.log(`stake confirmado: ${stake.opHash}`);

  const cycleSeconds = constants.blocks_per_cycle * Number(constants.minimal_block_delay);
  const waitCycles = constants.consensus_rights_delay + 2;
  opts.log(
    `direitos de consenso só valem daqui a ${constants.consensus_rights_delay} ciclos, e a ` +
      `recompensa do ciclo N só deve ser distribuída depois que N+2 começar. ` +
      `Ciclo em Bakingnet = ${constants.blocks_per_cycle} blocos × ${constants.minimal_block_delay} s = ` +
      `${(cycleSeconds / 3600).toFixed(1)} h. Espera total ≈ ${((waitCycles * cycleSeconds) / 3600).toFixed(0)} h.`,
  );

  return cohort;
}

/** Saca mais do faucet para o baker já existente. */
async function topUpBaker(cfg: HarnessConfig, rpc: RpcClient, opts: SetupOptions): Promise<Cohort> {
  const cohort = await loadCohort(cfg.stateDir);
  const before = await rpc.balance(cohort.baker.address);
  const hash = await new Faucet(cfg).fund(cohort.baker.address, opts.bakerFundingTez, opts.log);
  opts.log(`faucet enviou ${opts.bakerFundingTez} XTZ para ${cohort.baker.address} — ${hash}`);
  for (let i = 0; i < 40; i++) {
    const now = await rpc.balance(cohort.baker.address);
    if (now > before) {
      opts.log(`saldo: ${before} → ${now} mutez`);
      return cohort;
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  throw new Error('o saque do faucet não apareceu na cadeia.');
}

/**
 * Delega o coorte ao baker. Cada delegador assina a própria delegação — não existe batch
 * entre origens diferentes. Injeta com concorrência limitada; serializar 120 confirmações
 * é o que tornaria esta etapa inviável.
 */
async function delegateCohort(cfg: HarnessConfig, opts: SetupOptions): Promise<Cohort> {
  const cohort = await loadCohort(cfg.stateDir);
  const delegators = cohort.members.filter((m) => m.secretKey && m.role !== 'staker');
  opts.log(`delegando ${delegators.length} contas ao baker ${cohort.baker.address}...`);

  const results = await mapLimit(delegators, 6, async (m) => {
    try {
      const tk = new TezosToolkit(cfg.rpcUrl);
      tk.setSignerProvider(new InMemorySigner(m.secretKey!));
      const op = await tk.contract.setDelegate({ source: m.address, delegate: cohort.baker.address });
      await op.confirmation(1);
      return { id: m.id, error: null as string | null };
    } catch (err) {
      return { id: m.id, error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
    }
  });

  const failed = results.filter((r) => r.error);
  opts.log(`delegações: ${results.length - failed.length} ok, ${failed.length} com erro`);
  for (const f of failed.slice(0, 5)) opts.log(`  ${f.id}: ${f.error}`);
  return cohort;
}

async function waitForBalance(rpc: RpcClient, address: string, log: (m: string) => void): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const balance = await rpc.balance(address).catch(() => 0n);
    if (balance > 0n) {
      log(`saldo do baker confirmado na cadeia: ${balance} mutez`);
      return;
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  throw new Error(`saldo de ${address} continua zero depois de 4 minutos.`);
}
