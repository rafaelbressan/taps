import {
  assertBalanceCovers,
  assertBatchesFit,
  assertSafeToResend,
  computePayout,
  planBatches,
  sumMutez,
  type EstimatedTransfer,
  type FeeRate,
  type Mutez,
  type OperationOutcome,
  type PayoutPlan,
  type ProtocolConstants,
  type Recipient,
  type RewardSplit,
} from '@tezos-suite/chain';
import { buildDelegatorLines, type DelegatorLine } from './breakdown';
import type { BatchInjector, BatchTransfer } from './chain/injector';
import type { PayoutRpc } from './chain/rpc';
import type { PayoutSigner } from './chain/signer';
import {
  PayoutBlockedError,
  PayoutUnresolvedError,
} from './errors';
import {
  allocationCost,
  assertCycleCap,
  assertDestinationsAllowed,
  assertStorageAllocationCovered,
  type PayoutLimits,
} from './guard';
import { makeMinimumPayout } from './minimum';
import { assertCycleDistributable } from './schedule';
import type {
  BatchRecord,
  DistributionSnapshot,
  LineSettlement,
  PayoutStore,
} from './store/types';

/**
 * The payout engine.
 *
 * Idempotency here is a property of the design, not of a flag: the operation
 * hash is written to the store before the operation is injected, no resend
 * happens without reading the previous hash's state on chain, and the store's
 * `(bakerId, cycle)` key makes a second distribution of the same cycle
 * impossible rather than unlikely.
 */

export interface EnginePolicy {
  readonly fee: FeeRate;
  readonly includeBlockFees: boolean;
  /** The baker's own floor, in mutez. Never below the estimated fee. */
  readonly bakerFloorMutez: Mutez;
  readonly limits: PayoutLimits;
  /** Fraction of `hard_gas_limit_per_block` one batch may fill. */
  readonly blockGasUtilisationPercent?: number;
}

export interface RunRequest {
  readonly bakerId: string;
  readonly cycle: number;
  /** Who fired it. Goes into the audit trail verbatim. */
  readonly actor: string;
  /** From where: cli, scheduler, http + address. Also verbatim. */
  readonly source: string;
  readonly policy: EnginePolicy;
}

export type EstimateTransfers = (
  recipients: readonly Recipient[],
) => Promise<EstimatedTransfer[]>;

export interface OperationStateSource {
  resolve(
    opHash: string,
    branchLevel: number,
    constants: ProtocolConstants,
  ): Promise<OperationOutcome>;
}

export interface PayoutEngineDeps {
  readonly store: PayoutStore;
  readonly rpc: PayoutRpc;
  readonly signer: PayoutSigner;
  readonly injector: BatchInjector;
  readonly operations: OperationStateSource;
  readonly constants: () => Promise<ProtocolConstants>;
  /** Re-read right before the batch is built; the value is final only now. */
  readonly loadSplit: (bakerId: string, cycle: number) => Promise<RewardSplit>;
  readonly headCycle: () => Promise<number>;
  readonly estimate: EstimateTransfers;
  readonly network: string;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How many times one operation is polled before the run gives up. */
  readonly confirmationPolls?: number;
  readonly pollIntervalMs?: number;
  /** Injection attempts per batch per run. A resend needs `expired`/`failed`. */
  readonly attemptsPerBatch?: number;
}

export interface PayoutRunResult {
  readonly bakerId: string;
  readonly cycle: number;
  readonly status: DistributionSnapshot['distribution']['status'];
  /** Hashes injected by THIS run. Empty on a rerun — that is the proof. */
  readonly injected: readonly string[];
  /** Hashes that were already settled and were not touched. */
  readonly skipped: readonly string[];
  readonly totalSent: Mutez;
  readonly lines: readonly DelegatorLine[];
}

interface PlanningResult {
  readonly split: RewardSplit;
  readonly plan: PayoutPlan;
  readonly lines: DelegatorLine[];
  readonly transfers: EstimatedTransfer[];
}

export class PayoutEngine {
  private readonly clock: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly confirmationPolls: number;
  private readonly pollIntervalMs: number;
  private readonly attemptsPerBatch: number;

  constructor(private readonly deps: PayoutEngineDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.confirmationPolls = deps.confirmationPolls ?? 30;
    this.pollIntervalMs = deps.pollIntervalMs ?? 10_000;
    this.attemptsPerBatch = deps.attemptsPerBatch ?? 2;
  }

  /**
   * Runs, or resumes, the distribution of one cycle.
   *
   * Called twice with the same `(baker, cycle)`, the second call injects
   * nothing: either the store already holds a settled distribution, or every
   * batch already carries a hash whose on-chain state says the money moved.
   */
  async run(request: RunRequest): Promise<PayoutRunResult> {
    const { store } = this.deps;
    const constants = await this.deps.constants();

    await this.audit(request, 'distribution.requested', 'ok', {
      network: this.deps.network,
      protocolHash: constants.protocolHash,
      feeNumerator: request.policy.fee.numerator.toString(),
      feeDenominator: request.policy.fee.denominator.toString(),
      bakerFloorMutez: request.policy.bakerFloorMutez.toString(),
      cycleCapMutez: request.policy.limits.cycleCapMutez.toString(),
    });

    let snapshot = await store.getDistribution(request.bakerId, request.cycle);

    if (snapshot?.distribution.status === 'settled') {
      await this.audit(request, 'distribution.skipped', 'ok', {
        reason: 'already settled',
      });
      return this.resultOf(snapshot, [], batchHashes(snapshot.batches));
    }
    if (snapshot?.distribution.status === 'blocked') {
      throw new PayoutBlockedError(
        request.bakerId,
        request.cycle,
        'a previous run left this cycle blocked; clear it by hand before running again',
      );
    }

    if (!snapshot) {
      snapshot = await this.planAndPersist(request, constants);
    }

    return this.sendAll(request, snapshot, constants);
  }

  /**
   * Everything that decides an amount, in one place, before anything is
   * written or signed. Ends with a single transactional write.
   */
  private async planAndPersist(
    request: RunRequest,
    constants: ProtocolConstants,
  ): Promise<DistributionSnapshot> {
    const headCycle = await this.deps.headCycle();
    assertCycleDistributable(request.cycle, headCycle, constants);

    const planning = await this.plan(request, constants);
    const { split, plan, lines, transfers } = planning;

    const batchPlan = planBatches(transfers, constants, {
      blockGasUtilisationPercent: request.policy.blockGasUtilisationPercent,
    });
    assertBatchesFit(batchPlan, constants);
    assertCycleCap(batchPlan.totalCost, request.policy.limits, request.cycle);

    const source = await this.deps.signer.publicKeyHash();
    const balance = await this.deps.rpc.getBalance(source);
    assertBalanceCovers(batchPlan, balance);

    const snapshot = await this.deps.store.createDistribution({
      distribution: {
        bakerId: request.bakerId,
        cycle: request.cycle,
        network: this.deps.network,
        protocolHash: constants.protocolHash,
        pool: plan.pool,
        ownShare: plan.ownShare,
        bakerFee: plan.bakerFee,
        distributable: plan.distributable,
        remainder: plan.remainder,
        totalToSend: plan.totalToSend,
        feeNumerator: request.policy.fee.numerator,
        feeDenominator: request.policy.fee.denominator,
        blockFeesIncluded: plan.blockFeesIncluded,
        delegatorCount: split.delegators.length,
      },
      lines: lines.map((line) => ({
        bakerId: request.bakerId,
        cycle: request.cycle,
        address: line.address,
        delegatedBalanceMutez: line.delegatedBalance,
        grossMutez: line.gross,
        commissionMutez: line.commission,
        netMutez: line.net,
        carriedInMutez: line.carriedIn,
        payableMutez: line.payable,
        minimumMutez: line.minimum,
        withheldMutez: line.withheld,
        amountMutez: line.amount,
        carriedOutMutez: line.carriedOut,
        emptied: line.emptied,
      })),
      batches: batchPlan.batches.map((batch) => ({
        bakerId: request.bakerId,
        cycle: request.cycle,
        index: batch.index,
        transfers: batch.transfers.map((t) => ({
          address: t.address,
          amountMutez: t.amount,
          feeMutez: t.feeMutez,
          gasLimit: t.gasLimit,
          storageLimit: t.storageLimit,
          burnMutez: t.burnMutez,
        })),
        totalAmount: batch.totalAmount,
        totalFees: batch.totalFees,
        totalBurn: batch.totalBurn,
        totalGas: batch.totalGas,
        totalStorage: batch.totalStorage,
      })),
    });

    await this.audit(request, 'distribution.planned', 'ok', {
      pool: plan.pool.toString(),
      totalToSend: plan.totalToSend.toString(),
      delegators: split.delegators.length,
      paid: plan.toPay.length,
      deferred: plan.deferred.length,
      batches: batchPlan.batches.length,
      totalCost: batchPlan.totalCost.toString(),
      bakerBalance: balance.toString(),
    });

    return snapshot;
  }

  /**
   * Two passes over the same numbers, one network round trip.
   *
   * Pass one prices every delegator with a payable balance, because the
   * minimum payment IS the estimated fee of that very transfer. Pass two
   * re-runs the arithmetic with that cut in place. The amounts do not change
   * between the passes — the cut decides who is paid, not how much — so the
   * estimates from pass one are reused verbatim.
   */
  private async plan(
    request: RunRequest,
    constants: ProtocolConstants,
  ): Promise<PlanningResult> {
    const split = await this.deps.loadSplit(request.bakerId, request.cycle);
    const carryIn = await this.deps.store.loadCarryOver(request.bakerId);

    const provisional = computePayout({
      split,
      fee: request.policy.fee,
      includeBlockFees: request.policy.includeBlockFees,
      carryIn,
    });

    const candidates: Recipient[] = provisional.entries
      .filter((entry) => entry.payable > 0n)
      .map((entry) => ({
        address: entry.address,
        amount: entry.payable,
        emptied: entry.emptied,
      }));

    const estimates = await this.deps.estimate(candidates);
    const feeByAddress = new Map(estimates.map((e) => [e.address, e.feeMutez]));

    const plan = computePayout({
      split,
      fee: request.policy.fee,
      includeBlockFees: request.policy.includeBlockFees,
      carryIn,
      minimumPayout: makeMinimumPayout({
        feeByAddress,
        allocationBurn: allocationCost(constants),
        bakerFloor: request.policy.bakerFloorMutez,
      }),
    });

    const lines = buildDelegatorLines(split, plan, request.policy.fee);

    const paying = new Set(plan.toPay.map((entry) => entry.address));
    const transfers = estimates.filter((estimate) => paying.has(estimate.address));

    const needsAllocation = new Set(
      split.delegators.filter((d) => d.emptied).map((d) => d.address),
    );
    assertStorageAllocationCovered(transfers, needsAllocation, constants);
    assertDestinationsAllowed(
      transfers,
      new Set(split.delegators.map((d) => d.address)),
      request.bakerId,
      request.cycle,
    );

    for (const excluded of plan.deferred) {
      await this.audit(request, 'delegator.withheld', 'ok', {
        address: excluded.address,
        payableMutez: excluded.payable.toString(),
        cutMutez: excluded.minimum.toString(),
        carriedOutMutez: excluded.carriedOut.toString(),
      });
    }

    return { split, plan, lines, transfers };
  }

  /** Sends, resumes or skips every batch, in order, then settles once. */
  private async sendAll(
    request: RunRequest,
    initial: DistributionSnapshot,
    constants: ProtocolConstants,
  ): Promise<PayoutRunResult> {
    const injected: string[] = [];
    const skipped: string[] = [];
    const allowed = new Set(initial.lines.map((line) => line.address));
    const outcomes = new Map<number, 'confirmed' | 'failed'>();

    for (const batch of initial.batches) {
      const state = await this.settleBatch(request, batch, constants, allowed, {
        injected,
        skipped,
      });
      outcomes.set(batch.index, state);
    }

    const at = this.clock();
    const settlements: LineSettlement[] = [];
    const carryOver = new Map<string, Mutez>();
    const batchOf = new Map<string, BatchRecord>();
    for (const batch of initial.batches) {
      for (const transfer of batch.transfers) batchOf.set(transfer.address, batch);
    }

    const batchesNow = new Map<number, BatchRecord>();
    for (const batch of initial.batches) {
      const current = await this.deps.store.getBatch(
        request.bakerId,
        request.cycle,
        batch.index,
      );
      if (current) batchesNow.set(batch.index, current);
    }

    for (const line of initial.lines) {
      if (line.amountMutez === 0n) {
        settlements.push({
          address: line.address,
          result: 'deferred',
          batchIndex: null,
          opHash: null,
        });
        // Written for every line, including zero: a delegator who was paid
        // this cycle must have their earlier balance CLEARED, or the debt is
        // carried for ever and the next cycle pays it a second time.
        carryOver.set(line.address, line.carriedOutMutez);
        continue;
      }
      const batch = batchOf.get(line.address);
      const index = batch?.index ?? null;
      const confirmed = index !== null && outcomes.get(index) === 'confirmed';
      settlements.push({
        address: line.address,
        result: confirmed ? 'applied' : 'failed',
        batchIndex: index,
        opHash: index === null ? null : (batchesNow.get(index)?.opHash ?? null),
      });
      // A batch that did not land owes the delegator the same money next
      // cycle. Dropping it here would be a silent non-payment; and a batch
      // that did land clears whatever was carried into it.
      carryOver.set(line.address, confirmed ? 0n : line.payableMutez);
    }

    const everyBatchConfirmed = [...outcomes.values()].every((v) => v === 'confirmed');
    const status = everyBatchConfirmed ? 'settled' : 'failed';

    await this.deps.store.settleDistribution({
      bakerId: request.bakerId,
      cycle: request.cycle,
      status,
      lines: settlements,
      carryOver,
      at,
    });

    const final = await this.deps.store.getDistribution(request.bakerId, request.cycle);
    await this.audit(request, 'distribution.settled', everyBatchConfirmed ? 'ok' : 'error', {
      status,
      injected: injected.length,
      skipped: skipped.length,
    });

    return this.resultOf(final ?? initial, injected, skipped);
  }

  private async settleBatch(
    request: RunRequest,
    planned: BatchRecord,
    constants: ProtocolConstants,
    allowed: ReadonlySet<string>,
    tally: { injected: string[]; skipped: string[] },
  ): Promise<'confirmed' | 'failed'> {
    let record = planned;

    for (let attempt = 0; attempt < this.attemptsPerBatch; attempt += 1) {
      if (record.status === 'confirmed') {
        if (record.opHash) tally.skipped.push(record.opHash);
        return 'confirmed';
      }

      if (record.opHash !== null && record.branchLevel !== null) {
        const outcome = await this.awaitOutcome(request, record, constants);
        if (outcome.status === 'confirmed') {
          tally.skipped.push(record.opHash);
          return 'confirmed';
        }
        // Only `expired` and `failed` may be resent. Anything else means the
        // operation may still land, and resending it pays the same people
        // twice.
        try {
          assertSafeToResend(outcome);
        } catch (cause) {
          await this.block(request, (cause as Error).message);
          throw cause;
        }
        await this.audit(request, 'batch.resend', 'ok', {
          batch: record.index,
          previousOpHash: record.opHash,
          previousStatus: outcome.status,
        });
        // The store refuses a fresh attempt unless the batch is on record as
        // expired or failed, so the state written by `awaitOutcome` has to be
        // read back before the resend is attempted.
        record = (await this.reloadBatch(request, record.index)) ?? record;
      }

      record = await this.inject(request, record, allowed, tally);
      const outcome = await this.awaitOutcome(request, record, constants);
      if (outcome.status === 'confirmed') return 'confirmed';
      record = (await this.reloadBatch(request, record.index)) ?? record;
    }

    return 'failed';
  }

  /**
   * The order below is the whole idempotency story:
   * check the destinations, ask for the signature, WRITE THE HASH, inject.
   */
  private async inject(
    request: RunRequest,
    record: BatchRecord,
    allowed: ReadonlySet<string>,
    tally: { injected: string[]; skipped: string[] },
  ): Promise<BatchRecord> {
    const transfers = toBatchTransfers(record);

    try {
      assertDestinationsAllowed(transfers, allowed, request.bakerId, request.cycle);
    } catch (cause) {
      await this.audit(request, 'signature.refused', 'refused', {
        batch: record.index,
        detail: (cause as Error).message,
      });
      await this.block(request, (cause as Error).message);
      throw cause;
    }

    await this.audit(request, 'signature.requested', 'ok', {
      batch: record.index,
      destinations: record.transfers.map((t) => t.address),
      amounts: record.transfers.map((t) => t.amountMutez.toString()),
      totalAmountMutez: record.totalAmount.toString(),
      totalFeesMutez: record.totalFees.toString(),
    });

    const prepared = await this.deps.injector.prepare(transfers);

    // Durable before the node ever sees the bytes. If the process dies on the
    // next line, the resume finds this hash and asks the chain about it,
    // instead of building a second operation for the same money.
    await this.deps.store.recordInjectionIntent({
      bakerId: request.bakerId,
      cycle: request.cycle,
      index: record.index,
      opHash: prepared.opHash,
      counter: prepared.firstCounter.toString(),
      branch: prepared.branch,
      branchLevel: prepared.branchLevel,
      at: this.clock(),
    });
    await this.audit(request, 'injection.recorded', 'ok', {
      batch: record.index,
      opHash: prepared.opHash,
      branchLevel: prepared.branchLevel,
      counter: prepared.firstCounter.toString(),
    });

    await this.deps.injector.inject(prepared);
    tally.injected.push(prepared.opHash);

    await this.deps.store.recordBatchStatus({
      bakerId: request.bakerId,
      cycle: request.cycle,
      index: record.index,
      status: 'injected',
    });
    await this.audit(request, 'injection.accepted', 'ok', {
      batch: record.index,
      opHash: prepared.opHash,
    });

    return (await this.reloadBatch(request, record.index)) ?? record;
  }

  private async awaitOutcome(
    request: RunRequest,
    record: BatchRecord,
    constants: ProtocolConstants,
  ): Promise<OperationOutcome> {
    const opHash = record.opHash;
    const branchLevel = record.branchLevel;
    if (opHash === null || branchLevel === null) {
      throw new PayoutBlockedError(
        request.bakerId,
        request.cycle,
        `batch ${record.index} has no recorded operation to wait for`,
      );
    }

    let last: OperationOutcome | undefined;
    for (let poll = 0; poll < this.confirmationPolls; poll += 1) {
      const outcome = await this.deps.operations.resolve(opHash, branchLevel, constants);
      last = outcome;

      if (outcome.status === 'confirmed') {
        await this.deps.store.recordBatchStatus({
          bakerId: request.bakerId,
          cycle: request.cycle,
          index: record.index,
          status: 'confirmed',
          includedLevel: outcome.level ?? null,
          confirmedAt: this.clock(),
        });
        return outcome;
      }
      if (outcome.status === 'failed' || outcome.status === 'expired') {
        await this.deps.store.recordBatchStatus({
          bakerId: request.bakerId,
          cycle: request.cycle,
          index: record.index,
          status: outcome.status,
          includedLevel: outcome.level ?? null,
          error: outcome.chainStatus ?? outcome.status,
        });
        return outcome;
      }
      if (outcome.status === 'included') {
        await this.deps.store.recordBatchStatus({
          bakerId: request.bakerId,
          cycle: request.cycle,
          index: record.index,
          status: 'included',
          includedLevel: outcome.level ?? null,
        });
      }
      if (poll + 1 < this.confirmationPolls) await this.sleep(this.pollIntervalMs);
    }

    // Out of budget with the operation still live. The distribution stays
    // open on purpose: it is resumable, and resending now is the failure.
    await this.audit(request, 'batch.unresolved', 'error', {
      batch: record.index,
      opHash,
      status: last?.status ?? 'unknown',
    });
    throw new PayoutUnresolvedError(
      request.bakerId,
      request.cycle,
      opHash,
      last?.status ?? 'unknown',
    );
  }

  private reloadBatch(
    request: RunRequest,
    index: number,
  ): Promise<BatchRecord | undefined> {
    return this.deps.store.getBatch(request.bakerId, request.cycle, index);
  }

  private async block(request: RunRequest, reason: string): Promise<void> {
    await this.deps.store.setDistributionStatus(
      request.bakerId,
      request.cycle,
      'blocked',
      this.clock(),
    );
    await this.audit(request, 'distribution.blocked', 'error', { reason });
  }

  private async audit(
    request: RunRequest,
    action: string,
    outcome: 'ok' | 'refused' | 'error',
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.appendAudit({
      at: this.clock(),
      bakerId: request.bakerId,
      cycle: request.cycle,
      actor: request.actor,
      source: request.source,
      action,
      outcome,
      params,
    });
  }

  private resultOf(
    snapshot: DistributionSnapshot,
    injected: readonly string[],
    skipped: readonly string[],
  ): PayoutRunResult {
    return {
      bakerId: snapshot.distribution.bakerId,
      cycle: snapshot.distribution.cycle,
      status: snapshot.distribution.status,
      injected,
      skipped,
      totalSent: sumMutez(
        snapshot.lines.filter((l) => l.result === 'applied').map((l) => l.amountMutez),
      ),
      lines: snapshot.lines.map(
        (line): DelegatorLine => ({
          address: line.address,
          delegatedBalance: line.delegatedBalanceMutez,
          emptied: line.emptied,
          gross: line.grossMutez,
          commission: line.commissionMutez,
          net: line.netMutez,
          carriedIn: line.carriedInMutez,
          payable: line.payableMutez,
          minimum: line.minimumMutez,
          withheld: line.withheldMutez,
          amount: line.amountMutez,
          carriedOut: line.carriedOutMutez,
          paid: line.result === 'applied',
          reason:
            line.payableMutez === 0n ? 'zero' : line.amountMutez > 0n ? 'paid' : 'below-cut',
        }),
      ),
    };
  }
}

/**
 * The batch exactly as it was planned and persisted — per-transfer gas,
 * storage and fee, never a per-batch average. An average storage limit is
 * `storage_limit: 0` for the destination that needed 257, and the whole batch
 * comes back backtracked.
 */
function toBatchTransfers(record: BatchRecord): BatchTransfer[] {
  return record.transfers.map((transfer) => ({
    address: transfer.address,
    amount: transfer.amountMutez,
    feeMutez: transfer.feeMutez,
    gasLimit: transfer.gasLimit,
    storageLimit: transfer.storageLimit,
  }));
}

function batchHashes(batches: readonly BatchRecord[]): string[] {
  return batches
    .map((batch) => batch.opHash)
    .filter((hash): hash is string => hash !== null);
}
