import {
  assertBalanceCovers,
  assertBatchesFit,
  assertSafeToResend,
  computePayout,
  planBatches,
  sumMutez,
  type EstimatedBatch,
  type EstimatedTransfer,
  type RevealCost,
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
  NoOpenDebtError,
  OpenSettlementError,
  PayoutBlockedError,
  PayoutUnresolvedError,
  SettlementWindowError,
} from './errors';
import {
  allocationCost,
  assertCycleCap,
  assertDestinationsAllowed,
  assertSettlementCap,
  assertStorageAllocationCovered,
  type PayoutLimits,
} from './guard';
import {
  formatPayoutFactor,
  makeMinimumPayout,
  transferCost,
  type PayoutFactor,
} from './minimum';
import { assertCycleDistributable } from './schedule';
import type {
  BatchRecord,
  DebtSettlementRecord,
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
  /**
   * K of RN-24: what is owed enters the batch only when it covers K times the
   * estimated cost of that transfer. Relative, because the cost of a transfer
   * moves with the network; the baker's, because the trade it makes — less
   * waste in fees against a longer wait for the small delegator — is theirs.
   */
  readonly payoutFactor: PayoutFactor;
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

/**
 * A request to pay open debt outside any cycle (RN-24, borda 1).
 *
 * `settlementId` is the idempotency key and is chosen by the caller — a date,
 * a ticket number, whatever the baker will recognise a year later. Asking
 * twice under the same id pays once.
 */
export interface DebtSettlementRequest {
  readonly bakerId: string;
  readonly settlementId: string;
  /** Whose debt to pay. Each must have a balance on record, or the run stops. */
  readonly addresses: readonly string[];
  readonly actor: string;
  readonly source: string;
  /** Why a human asked for this. Goes into the audit trail verbatim. */
  readonly reason: string;
  readonly limits: PayoutLimits;
  readonly blockGasUtilisationPercent?: number;
}

export interface DebtSettlementResult {
  readonly bakerId: string;
  readonly settlementId: string;
  readonly status: DebtSettlementRecord['status'];
  readonly opHash: string | null;
  readonly paid: readonly { readonly address: string; readonly amountMutez: Mutez }[];
  readonly totalPaid: Mutez;
  /** Hashes injected by THIS call. Empty on a rerun — that is the proof. */
  readonly injected: readonly string[];
  readonly skipped: readonly string[];
}

export type EstimateTransfers = (
  recipients: readonly Recipient[],
) => Promise<EstimatedBatch>;

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
  /**
   * What one transfer to each address cost this run. Persisted per line so
   * that `minimum == ceil(K x cost)` stays checkable years later: the cut is
   * only explainable if BOTH halves of it were written down.
   */
  readonly transferCostByAddress: ReadonlyMap<string, Mutez>;
  /**
   * The reveal the paying account still owes, when it owes one. Lives with
   * the plan and not with a batch: it is not a transfer, and a batch that
   * carried it could not be rebuilt from the store on a resume (BRES-137).
   */
  readonly reveal: RevealCost | null;
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
      payoutFactor: formatPayoutFactor(request.policy.payoutFactor),
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
    if (snapshot?.distribution.status === 'failed') {
      // The persisted batches are the ones the chain already rejected. Sending
      // them again sends the same bytes to the same fate and burns the fees a
      // second time — measured on Bakingnet, where six identical batches died
      // on the same `gas_exhausted.operation`. Re-planning needs fresh
      // estimates, which is a new decision, not a retry.
      throw new PayoutBlockedError(
        request.bakerId,
        request.cycle,
        'a previous run ended failed on chain; the stored batches would fail the same way, ' +
          'so re-planning is a human decision',
      );
    }

    // `reveal` only exists on a run that planned. A resumed run rebuilds its
    // batches from the store, where no estimate lives — and by then the
    // account is revealed anyway, unless the first attempt died between
    // planning and the reveal. That one case refuses with a sentence naming
    // the account instead of a broken invariant (BRES-137).
    let reveal: RevealCost | null = null;
    if (!snapshot) {
      const planned = await this.planAndPersist(request, constants);
      snapshot = planned.snapshot;
      reveal = planned.reveal;
    }

    return this.sendAll(request, snapshot, constants, reveal);
  }

  /**
   * Pays an open debt on request (RN-24, borda 1).
   *
   * A delegator who stops delegating with a balance below the cut never earns
   * again: the balance never grows, and so it never clears the cut on its
   * own. The debt is the baker's and does not expire because the delegator
   * went quiet, which leaves exactly one honest way out — someone decides to
   * pay it, accepting that the fee may cost more than the amount it moves.
   *
   * Deliberately outside the automatic path and outside any cycle: it is
   * reached only by a human, it belongs to no cycle's reconciliation, and it
   * makes AT MOST ONE injection attempt. A settlement that expired or was
   * rejected is not retried under the same name; the debt is still on record,
   * and asking again is another decision, with another id.
   */
  async settleDebt(request: DebtSettlementRequest): Promise<DebtSettlementResult> {
    const { store } = this.deps;
    const constants = await this.deps.constants();

    await this.record(request.bakerId, null, request.actor, request.source,
      'settlement.requested', 'ok', {
        settlementId: request.settlementId,
        addresses: request.addresses,
        reason: request.reason,
      });

    const existing = await store.getDebtSettlement(request.bakerId, request.settlementId);
    if (existing?.status === 'settled') {
      await this.record(request.bakerId, null, request.actor, request.source,
        'settlement.skipped', 'ok', { settlementId: request.settlementId, reason: 'already settled' });
      return settlementResult(existing, [], existing.opHash ? [existing.opHash] : []);
    }
    if (existing && (existing.status === 'failed' || existing.status === 'blocked')) {
      throw new PayoutBlockedError(
        request.bakerId,
        null,
        `debt settlement ${request.settlementId} ended "${existing.status}" ` +
          `(${existing.error ?? 'no chain error recorded'}); the debt is still on record, and ` +
          'asking again is a new decision under a new settlement id',
      );
    }

    // A settlement already on record has no fresh estimate behind it, so it
    // has no reveal either — by then the account has been revealed anyway.
    const planned = existing ? null : await this.planSettlement(request, constants);
    const record = existing ?? planned!.record;
    return this.sendSettlement(request, record, constants, planned?.reveal ?? null);
  }

  /** Everything that decides an amount, before anything is written or signed. */
  private async planSettlement(
    request: DebtSettlementRequest,
    constants: ProtocolConstants,
  ): Promise<{ record: DebtSettlementRecord; reveal: RevealCost | null }> {
    const { store } = this.deps;

    // An open distribution has already read the carry-over it intends to pay.
    // Paying it here as well is the double payment this engine exists to make
    // impossible, so the window is closed rather than narrowed.
    const statuses = await store.listCycleStatuses(request.bakerId);
    const open = [...statuses.entries()]
      .filter(([, status]) => status === 'planned' || status === 'sending')
      .map(([cycle]) => cycle)
      .sort((a, b) => a - b);
    if (open.length > 0) throw new SettlementWindowError(request.bakerId, open);

    const debts = await store.loadCarryOver(request.bakerId);
    const recipients: Recipient[] = [];
    for (const address of request.addresses) {
      const owed = debts.get(address);
      if (owed === undefined || owed <= 0n) {
        throw new NoOpenDebtError(request.bakerId, address);
      }
      // An implicit account with no balance is not allocated, and paying it
      // burns storage. Read per address rather than assumed: a `storage_limit`
      // that is wrong by omission takes the whole operation down.
      const balance = await this.deps.rpc.getBalance(address);
      recipients.push({ address, amount: owed, emptied: balance === 0n });
    }

    const { transfers: estimates, reveal } = await this.deps.estimate(recipients);
    const batchPlan = planBatches(estimates, constants, {
      blockGasUtilisationPercent: request.blockGasUtilisationPercent,
      reveal,
    });
    if (batchPlan.batches.length !== 1) {
      throw new PayoutBlockedError(
        request.bakerId,
        null,
        `${request.addresses.length} debts do not fit one operation ` +
          `(${batchPlan.batches.length} would be needed) — split the request, so that every ` +
          'settlement is one operation whose hash answers for it entirely',
      );
    }
    assertBatchesFit(batchPlan, constants);
    assertSettlementCap(batchPlan.totalCost, request.limits, request.settlementId);
    assertStorageAllocationCovered(
      estimates,
      new Set(recipients.filter((r) => r.emptied).map((r) => r.address)),
      constants,
    );
    assertDestinationsAllowed(estimates, new Set(request.addresses), request.bakerId, null);

    const balance = await this.deps.rpc.getBalance(await this.deps.signer.publicKeyHash());
    assertBalanceCovers(batchPlan, balance);

    const batch = batchPlan.batches[0]!;
    const record = await store.createDebtSettlement({
      bakerId: request.bakerId,
      settlementId: request.settlementId,
      network: this.deps.network,
      protocolHash: constants.protocolHash,
      actor: request.actor,
      reason: request.reason,
      lines: batch.transfers.map((transfer) => ({
        address: transfer.address,
        amountMutez: transfer.amount,
        feeMutez: transfer.feeMutez,
        gasLimit: transfer.gasLimit,
        storageLimit: transfer.storageLimit,
        burnMutez: transfer.burnMutez,
      })),
      totalAmount: batch.totalAmount,
      totalFees: batch.totalFees,
      totalBurn: batch.totalBurn,
    });
    return { record, reveal };
  }

  /**
   * One attempt, in the order that makes it safe: check the destinations, ask
   * for the signature, WRITE THE HASH, inject, then ask the chain.
   */
  private async sendSettlement(
    request: DebtSettlementRequest,
    planned: DebtSettlementRecord,
    constants: ProtocolConstants,
    reveal: RevealCost | null = null,
  ): Promise<DebtSettlementResult> {
    const { store } = this.deps;
    // Checked against what the HUMAN asked for, not against the record's own
    // lines: a check whose condition restates how the value was built is the
    // `validateCalculation()` of the current TAPS, which passed while every
    // total was zero. On a resume this is the only thing standing between a
    // tampered store and a signature for someone else's address.
    const allowed = new Set(request.addresses);
    const injected: string[] = [];
    let record = planned;

    if (record.opHash === null) {
      const transfers: BatchTransfer[] = record.lines.map((line) => ({
        address: line.address,
        amount: line.amountMutez,
        feeMutez: line.feeMutez,
        gasLimit: line.gasLimit,
        storageLimit: line.storageLimit,
      }));
      assertDestinationsAllowed(transfers, allowed, request.bakerId, null);

      await this.record(request.bakerId, null, request.actor, request.source,
        'settlement.signature.requested', 'ok', {
          settlementId: request.settlementId,
          destinations: transfers.map((t) => t.address),
          amounts: transfers.map((t) => t.amount.toString()),
          totalAmountMutez: record.totalAmount.toString(),
        });

      const prepared = await this.deps.injector.prepare(transfers, reveal);
      await store.recordSettlementIntent({
        bakerId: request.bakerId,
        settlementId: request.settlementId,
        opHash: prepared.opHash,
        counter: prepared.firstCounter.toString(),
        branch: prepared.branch,
        branchLevel: prepared.branchLevel,
        at: this.clock(),
      });
      await this.record(request.bakerId, null, request.actor, request.source,
        'settlement.injection.recorded', 'ok', {
          settlementId: request.settlementId,
          opHash: prepared.opHash,
          branchLevel: prepared.branchLevel,
        });

      await this.deps.injector.inject(prepared);
      injected.push(prepared.opHash);
      record =
        (await store.getDebtSettlement(request.bakerId, request.settlementId)) ?? record;
    }

    const opHash = record.opHash;
    const branchLevel = record.branchLevel;
    if (opHash === null || branchLevel === null) {
      throw new PayoutBlockedError(
        request.bakerId,
        null,
        `debt settlement ${request.settlementId} has no recorded operation to wait for`,
      );
    }

    let last: OperationOutcome | undefined;
    for (let poll = 0; poll < this.confirmationPolls; poll += 1) {
      const outcome = await this.deps.operations.resolve(opHash, branchLevel, constants);
      last = outcome;

      if (outcome.status === 'confirmed') {
        const at = this.clock();
        // Status and cleared debts in one write: a debt cleared without a
        // confirmed operation is a debt silently forgiven.
        await store.recordSettlementStatus({
          bakerId: request.bakerId,
          settlementId: request.settlementId,
          status: 'settled',
          includedLevel: outcome.level ?? null,
          confirmedAt: at,
          cleared: record.lines.map((line) => line.address),
          at,
        });
        await this.record(request.bakerId, null, request.actor, request.source,
          'settlement.settled', 'ok', {
            settlementId: request.settlementId,
            opHash,
            totalAmountMutez: record.totalAmount.toString(),
          });
        const settled =
          (await store.getDebtSettlement(request.bakerId, request.settlementId)) ?? record;
        return settlementResult(settled, injected, injected.length > 0 ? [] : [opHash]);
      }

      if (outcome.status === 'failed' || outcome.status === 'expired') {
        const at = this.clock();
        await store.recordSettlementStatus({
          bakerId: request.bakerId,
          settlementId: request.settlementId,
          status: 'failed',
          includedLevel: outcome.level ?? null,
          error: outcome.chainStatus ?? outcome.status,
          at,
        });
        await this.record(request.bakerId, null, request.actor, request.source,
          'settlement.failed', 'error', {
            settlementId: request.settlementId,
            opHash,
            chainStatus: outcome.chainStatus ?? outcome.status,
          });
        const failed =
          (await store.getDebtSettlement(request.bakerId, request.settlementId)) ?? record;
        return settlementResult(failed, injected, []);
      }

      if (poll + 1 < this.confirmationPolls) await this.sleep(this.pollIntervalMs);
    }

    // Out of budget with the operation still live. The record stays `sending`
    // on purpose: re-running the SAME id asks the chain about this hash again
    // and never builds a second one.
    await this.record(request.bakerId, null, request.actor, request.source,
      'settlement.unresolved', 'error', {
        settlementId: request.settlementId,
        opHash,
        status: last?.status ?? 'unknown',
      });
    throw new PayoutUnresolvedError(
      request.bakerId,
      null,
      opHash,
      last?.status ?? 'unknown',
    );
  }

  /**
   * Everything that decides an amount, in one place, before anything is
   * written or signed. Ends with a single transactional write.
   */
  private async planAndPersist(
    request: RunRequest,
    constants: ProtocolConstants,
  ): Promise<{ snapshot: DistributionSnapshot; reveal: RevealCost | null }> {
    const headCycle = await this.deps.headCycle();
    assertCycleDistributable(request.cycle, headCycle, constants);

    // The other half of the window `planSettlement` closes. Everything below
    // reads the carry-over; an in-flight settlement is already paying part of
    // it and has cleared nothing yet.
    const settlements = await this.deps.store.listOpenSettlements(request.bakerId);
    if (settlements.length > 0) {
      throw new OpenSettlementError(request.bakerId, settlements);
    }

    const planning = await this.plan(request, constants);
    const { split, plan, lines, transfers, transferCostByAddress, reveal } = planning;

    const batchPlan = planBatches(transfers, constants, {
      blockGasUtilisationPercent: request.policy.blockGasUtilisationPercent,
      reveal,
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
        payoutFactorNumerator: request.policy.payoutFactor.numerator,
        payoutFactorDenominator: request.policy.payoutFactor.denominator,
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
        transferCostMutez: transferCostByAddress.get(line.address) ?? 0n,
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
      payoutFactor: formatPayoutFactor(request.policy.payoutFactor),
    });

    return { snapshot, reveal };
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

    const { transfers: estimates, reveal } = await this.deps.estimate(candidates);
    const costs = {
      feeByAddress: new Map(estimates.map((e) => [e.address, e.feeMutez])),
      allocationBurn: allocationCost(constants),
      factor: request.policy.payoutFactor,
    };

    const plan = computePayout({
      split,
      fee: request.policy.fee,
      includeBlockFees: request.policy.includeBlockFees,
      carryIn,
      minimumPayout: makeMinimumPayout(costs),
    });

    const lines = buildDelegatorLines(split, plan, request.policy.fee);

    const transferCostByAddress = new Map<string, Mutez>(
      plan.entries.map((entry) => [
        entry.address,
        // A delegator with nothing owed was never priced, and pricing a
        // transfer that will never exist would only make the estimation pass
        // larger. Zero here means "not applicable", and the cut is zero too.
        entry.payable > 0n ? transferCost(costs, entry.address, entry.emptied) : 0n,
      ]),
    );

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
        transferCostMutez: (transferCostByAddress.get(excluded.address) ?? 0n).toString(),
        payoutFactor: formatPayoutFactor(request.policy.payoutFactor),
        cutMutez: excluded.minimum.toString(),
        carriedOutMutez: excluded.carriedOut.toString(),
      });
    }

    return { split, plan, lines, transfers, transferCostByAddress, reveal };
  }

  /** Sends, resumes or skips every batch, in order, then settles once. */
  private async sendAll(
    request: RunRequest,
    initial: DistributionSnapshot,
    constants: ProtocolConstants,
    reveal: RevealCost | null = null,
  ): Promise<PayoutRunResult> {
    const injected: string[] = [];
    const skipped: string[] = [];
    const allowed = new Set(initial.lines.map((line) => line.address));
    const outcomes = new Map<number, 'confirmed' | 'failed'>();

    for (const batch of initial.batches) {
      const state = await this.settleBatch(
        request,
        batch,
        constants,
        allowed,
        { injected, skipped },
        reveal,
      );
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
    reveal: RevealCost | null = null,
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
        // Only `expired` and `failed` are safe to resend at all — anything
        // else may still land, and resending it pays the same people twice.
        try {
          assertSafeToResend(outcome);
        } catch (cause) {
          await this.block(request, (cause as Error).message);
          throw cause;
        }

        // Safe is not the same as useful. `failed` means the operation reached
        // a block and the chain rejected it, so the identical bytes will be
        // rejected identically; only the fees would be new. `expired` is the
        // one worth resending: it never made it into a block at all.
        if (outcome.status === 'failed') {
          await this.audit(request, 'batch.failed', 'error', {
            batch: record.index,
            opHash: record.opHash,
            chainStatus: outcome.chainStatus ?? 'failed',
          });
          return 'failed';
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

      record = await this.inject(request, record, allowed, tally, reveal);
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
    reveal: RevealCost | null = null,
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

    const prepared = await this.deps.injector.prepare(transfers, reveal);
    if (prepared.revealOpHash) {
      await this.audit(request, 'account.revealed', 'ok', {
        batch: record.index,
        opHash: prepared.revealOpHash,
      });
    }

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

  private audit(
    request: RunRequest,
    action: string,
    outcome: 'ok' | 'refused' | 'error',
    params: Record<string, unknown>,
  ): Promise<void> {
    return this.record(
      request.bakerId,
      request.cycle,
      request.actor,
      request.source,
      action,
      outcome,
      params,
    );
  }

  /** The audit write itself. `cycle: null` is the out-of-cycle settlement. */
  private async record(
    bakerId: string,
    cycle: number | null,
    actor: string,
    source: string,
    action: string,
    outcome: 'ok' | 'refused' | 'error',
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.appendAudit({
      at: this.clock(),
      bakerId,
      cycle,
      actor,
      source,
      action,
      outcome,
      params,
      ...auditColumns(params),
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

function settlementResult(
  record: DebtSettlementRecord,
  injected: readonly string[],
  skipped: readonly string[],
): DebtSettlementResult {
  return {
    bakerId: record.bakerId,
    settlementId: record.settlementId,
    status: record.status,
    opHash: record.opHash,
    paid: record.lines.map((line) => ({
      address: line.address,
      amountMutez: line.amountMutez,
    })),
    // What the operation carried. Only a `settled` record means it arrived —
    // the amount is what was sent, not proof that it landed.
    totalPaid: record.status === 'settled' ? record.totalAmount : 0n,
    injected,
    skipped,
  };
}

function batchHashes(batches: readonly BatchRecord[]): string[] {
  return batches
    .map((batch) => batch.opHash)
    .filter((hash): hash is string => hash !== null);
}

/**
 * O valor, os destinos e o motivo saem dos próprios `params`.
 *
 * As colunas existem na tabela desde sempre e ninguém as preenchia: a Trilha
 * mostrava "—" em VALOR e OPERAÇÃO mesmo numa linha que carregava o total
 * assinado, e o motivo de um erro só existia dentro do JSON. Ler daqui evita
 * repetir o valor em cada uma das dezenas de chamadas de auditoria.
 */
export function auditColumns(params: Readonly<Record<string, unknown>>): {
  amountMutez?: Mutez;
  destinations?: readonly string[];
  opHash?: string;
  detail?: string;
} {
  const columns: {
    amountMutez?: Mutez;
    destinations?: readonly string[];
    opHash?: string;
    detail?: string;
  } = {};

  const amount = params.totalAmountMutez ?? params.totalToSend ?? params.amountMutez;
  if (typeof amount === 'string' && /^\d+$/.test(amount)) {
    columns.amountMutez = BigInt(amount);
  } else if (typeof amount === 'bigint') {
    columns.amountMutez = amount;
  }

  const { destinations } = params;
  if (Array.isArray(destinations) && destinations.every((d) => typeof d === 'string')) {
    columns.destinations = destinations as readonly string[];
  }

  if (typeof params.opHash === 'string') columns.opHash = params.opHash;

  const detail = params.reason ?? params.detail;
  if (typeof detail === 'string') columns.detail = detail;

  return columns;
}
