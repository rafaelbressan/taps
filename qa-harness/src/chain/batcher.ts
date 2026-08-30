/**
 * Execução do plano na cadeia, com as três travas que o TAPS atual não tem:
 * diário de injeção (idempotência), storage limit real, e lote dimensionado por gas.
 */
import { TezosToolkit, type OpKind } from '@taquito/taquito';
import type { HarnessConfig } from '../config.ts';
import type { ExecutionResult, InjectionRecord, PayoutPlan, PlannedPayment } from '../payout/types.ts';
import type { RpcClient, ProtocolConstants } from './rpc.ts';
import type { TzktClient } from './tzkt.ts';
import { Journal } from './journal.ts';
import { Sabotage } from '../payout/sabotage.ts';

export interface BatcherDeps {
  cfg: HarnessConfig;
  toolkit: TezosToolkit;
  rpc: RpcClient;
  tzkt: TzktClient;
  constants: ProtocolConstants;
  journal: Journal;
  bakerAddress: string;
  sabotage?: Sabotage;
}

/** Margem sobre o gas estimado; o teto real é por bloco e é conhecido só após estimar. */
const GAS_SAFETY_NUM = 12n;
const GAS_SAFETY_DEN = 10n;

/** Um pagamento já com gas, storage e taxa vindos da estimativa da rede. */
interface EstimatedPayment {
  address: string;
  amount: bigint;
  fee: number;
  gasLimit: number;
  storageLimit: number;
}

export class Batcher {
  private readonly sabotage: Sabotage;
  /** Custo medido de uma transferência nesta rede, preenchido por `calibrate()`. */
  private transferFee = 0n;
  private allocationBurn = 0n;

  constructor(private readonly d: BatcherDeps) {
    this.sabotage = d.sabotage ?? new Sabotage();
  }

  /**
   * Mede na rede o custo de uma transferência e o burn de alocação, em vez de
   * escrever 477 e 64250 no código. Os dois flutuam: a taxa com a demanda, o burn
   * com `origination_size × cost_per_byte`, ambos lidos da cadeia.
   */
  async calibrate(probeDestination: string): Promise<{ fee: bigint; allocationBurn: bigint }> {
    const est = await this.d.toolkit.estimate.transfer({ to: probeDestination, amount: 1, mutez: true });
    this.transferFee = BigInt(est.suggestedFeeMutez);
    this.gasPerTransfer = BigInt(est.gasLimit);
    this.allocationBurn =
      BigInt(this.d.constants.origination_size) * BigInt(this.d.constants.cost_per_byte);
    return { fee: this.transferFee, allocationBurn: this.allocationBurn };
  }

  /** Custo de pagar um destinatário: taxa + burn se a conta precisar ser alocada. */
  estimatedTransferCost(needsAllocation: boolean): bigint {
    if (this.transferFee === 0n) {
      throw new Error('Batcher.calibrate() não foi chamado — o piso viraria constante no código.');
    }
    return this.transferFee + (needsAllocation ? this.allocationBurn : 0n);
  }

  async send(plan: PayoutPlan): Promise<ExecutionResult> {
    const key = `${plan.baker}:${plan.cycle}`;

    // --- Trava 1: o diário. É esta consulta que impede o pagamento duplicado. ---
    if (!this.sabotage.has('idempotency')) {
      const prior = await this.d.journal.read(key);
      if (prior.length > 0) {
        const settled = await this.#allSettled(prior);
        if (settled) {
          return { injected: [], skipped: prior };
        }
        throw new Error(
          `ciclo ${plan.cycle} tem injeção anterior em estado não resolvido. ` +
            `Não reenvie: releia o opHash on-chain e espere expirar (branch + ` +
            `${this.d.constants.max_operations_time_to_live} blocos) antes de decidir.`,
        );
      }
    }

    const toPay = plan.payments.filter((p) => p.amount > 0n);
    if (toPay.length === 0) return { injected: [], skipped: [] };

    await this.#assertBakerCanAfford(plan, toPay.length);

    // Uma chamada de estimativa por lote, e usa-se o que ela devolve. Deixar o Taquito
    // adivinhar gas por operação é o que produz `gas_exhausted.operation`; escrever o gas
    // no código é o que produz o oposto — 7× a mais, e um lote 6× menor do que caberia.
    const estimated = await this.#estimate(toPay);
    const batches = this.#splitIntoBatches(estimated);
    const injected: InjectionRecord[] = [];

    for (const batch of batches) {
      const header = await this.d.rpc.header();
      const counter = await this.d.rpc.counter(this.d.bakerAddress);

      const transfers = batch.map((e) => ({
        kind: 'transaction' as OpKind.TRANSACTION,
        to: e.address,
        amount: Number(e.amount),
        mutez: true,
        fee: e.fee,
        gasLimit: e.gasLimit,
        // storage_limit fixo em 0 é o que derruba o lote inteiro quando um
        // destinatário nunca foi alocado.
        storageLimit: this.sabotage.has('storage-limit') ? 0 : e.storageLimit,
      }));

      // --- Trava 2: gravar a intenção ANTES de injetar. ---
      // O opHash só existe depois; o que se grava antes é (counter, branch), que já
      // basta para saber que o dinheiro PODE ter saído.
      const pending: InjectionRecord = {
        opHash: '',
        counter: (counter + 1n).toString(),
        branchLevel: header.level,
        addresses: batch.map((e) => e.address),
        amounts: batch.map((e) => e.amount.toString()),
        injectedAt: new Date().toISOString(),
      };
      await this.d.journal.append(key, pending);

      const op = await this.d.toolkit.contract.batch(transfers).send();
      const record: InjectionRecord = { ...pending, opHash: op.hash };
      await this.d.journal.append(key, record);
      injected.push(record);

      // Confirmação: incluída em L e head >= L+2. A releitura independente do bloco
      // e do status fica com a reconciliação, que confere pela TzKT e pela RPC.
      await op.confirmation(2);
    }

    return { injected, skipped: [] };
  }

  /**
   * `estimate.batch()` sobre o plano inteiro, em pedaços que caibam numa simulação.
   * Devolve, por destinatário, o gas/storage/fee que a **rede** disse — não o que o
   * código achava.
   */
  async #estimate(payments: readonly PlannedPayment[]): Promise<EstimatedPayment[]> {
    const perChunk = this.#opsPerBlockEstimate();
    const out: EstimatedPayment[] = [];

    for (let i = 0; i < payments.length; i += perChunk) {
      const chunk = payments.slice(i, i + perChunk);
      const params = chunk.map((p) => ({
        kind: 'transaction' as OpKind.TRANSACTION,
        to: p.address,
        amount: Number(p.amount),
        mutez: true,
      }));
      const estimates = await this.d.toolkit.estimate.batch(params);
      estimates.forEach((e, j) => {
        const p = chunk[j]!;
        out.push({
          address: p.address,
          amount: p.amount,
          fee: e.suggestedFeeMutez,
          gasLimit: e.gasLimit,
          storageLimit: e.storageLimit,
        });
      });
    }
    return out;
  }

  /** Quantas transferências cabem no gas de um bloco, pelo número medido na calibração. */
  #opsPerBlockEstimate(): number {
    const blockGas = BigInt(this.d.constants.hard_gas_limit_per_block);
    const perOp = (this.gasPerTransfer * GAS_SAFETY_NUM) / GAS_SAFETY_DEN;
    return Math.max(1, Number(blockGas / perOp));
  }

  /**
   * "Já resolvido" só é verdade quando a cadeia diz. `unknown` (204 da TzKT) não é
   * "não paga" — é "não sei", e reenviar sobre "não sei" é como se paga duas vezes.
   */
  async #allSettled(records: readonly InjectionRecord[]): Promise<boolean> {
    const withHash = records.filter((r) => r.opHash !== '');
    if (withHash.length === 0) return false;
    for (const r of withHash) {
      const status = await this.d.tzkt.operationStatus(r.opHash);
      if (status !== 'applied') return false;
    }
    // Toda intenção gravada precisa ter virado uma injeção conhecida.
    const intents = records.filter((r) => r.opHash === '').length;
    return withHash.length >= intents;
  }

  async #assertBakerCanAfford(plan: PayoutPlan, recipients: number): Promise<void> {
    const balance = await this.d.rpc.balance(this.d.bakerAddress);
    const allocations = BigInt(plan.payments.filter((p) => p.amount > 0n && p.needsAllocation).length);
    const needed =
      plan.totalToSend + this.transferFee * BigInt(recipients) + this.allocationBurn * allocations;
    if (balance < needed) {
      throw new Error(
        `saldo do baker insuficiente: tem ${balance} mutez, precisa de ${needed} ` +
          `(${plan.totalToSend} a pagar + taxas + ${allocations} alocações). ` +
          `Um lote que falha no meio deixa metade dos delegadores sem receber.`,
      );
    }
  }

  /**
   * O teto do lote é o gas do **bloco**, somado sobre o gas que a estimativa devolveu.
   * `MAX_BATCH_SIZE = 100` não é perigoso — é conservador demais; o que é perigoso é
   * não dividir, porque aí acima do teto o lote simplesmente falha.
   */
  #splitIntoBatches(payments: readonly EstimatedPayment[]): EstimatedPayment[][] {
    if (this.sabotage.has('batch-cap')) {
      // Mutante: corta em 100 e descarta o resto, em silêncio.
      return [payments.slice(0, 100)];
    }
    const blockGas = BigInt(this.d.constants.hard_gas_limit_per_block);
    const budget = (blockGas * GAS_SAFETY_DEN) / GAS_SAFETY_NUM;

    const out: EstimatedPayment[][] = [];
    let current: EstimatedPayment[] = [];
    let used = 0n;

    for (const p of payments) {
      const gas = BigInt(p.gasLimit);
      if (gas > budget) {
        throw new Error(`uma única transferência pede ${gas} de gas, acima do orçamento de bloco ${budget}.`);
      }
      if (used + gas > budget && current.length > 0) {
        out.push(current);
        current = [];
        used = 0n;
      }
      current.push(p);
      used += gas;
    }
    if (current.length > 0) out.push(current);
    return out;
  }

  /**
   * Gas de uma transferência tz→tz, medido pela estimativa em `calibrate()`.
   * Público porque o relatório mostra o número que foi realmente usado.
   */
  gasPerTransfer = 2500n;
}
