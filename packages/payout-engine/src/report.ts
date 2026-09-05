import { InvariantViolationError, sumMutez, type Mutez } from '@tezos-suite/chain';
import { formatPayoutFactor, type PayoutFactor } from './minimum';
import type { DelegatorLineRecord, DistributionSnapshot, LineResult } from './store/types';

/**
 * The cycle report (RN-24, borda 2).
 *
 * "O corte não é motivo para esconder o delegador do relatório. Ele aparece
 * em todo ciclo com o devido do ciclo e a dívida acumulada, senão a regra
 * vira 'some com quem é pequeno'."
 *
 * So the report is built from EVERY persisted line, not from the batch. A
 * delegator below the cut has a row with what the cycle owed them
 * (`netMutez`) and what the baker now carries for them (`carriedOutMutez`) —
 * and `assertReportComplete` fails if a line ever goes missing.
 *
 * Nothing here computes an amount. Every number is read from what was
 * written at distribution time, because the cut of a past cycle is not
 * reproducible: it was `K × estimated cost`, and the network fee has moved
 * since.
 */

export type RowStatus =
  /** Paid this cycle. */
  | 'paid'
  /** Owed something, below the cut; the amount is now debt. */
  | 'below-cut'
  /** Owed nothing this cycle and carries no balance. */
  | 'zero'
  /** Cleared the cut and the operation did not land. Still owed. */
  | 'unpaid';

export interface CycleReportRow {
  readonly address: string;
  readonly delegatedBalanceMutez: Mutez;
  readonly grossMutez: Mutez;
  readonly commissionMutez: Mutez;
  /** What this cycle owed them, after commission. The "devido do ciclo". */
  readonly owedThisCycleMutez: Mutez;
  /** Debt brought in from earlier cycles. */
  readonly carriedInMutez: Mutez;
  /** `owedThisCycle + carriedIn` — what was compared against the cut. */
  readonly payableMutez: Mutez;
  /** What one transfer to them cost this cycle, as estimated. */
  readonly transferCostMutez: Mutez;
  /** The cut applied: `K × transferCost`, rounded up. */
  readonly cutMutez: Mutez;
  readonly paidMutez: Mutez;
  /** Debt carried out of this cycle. The "dívida acumulada". */
  readonly debtMutez: Mutez;
  readonly status: RowStatus;
  readonly opHash: string | null;
}

export interface CycleReport {
  readonly bakerId: string;
  readonly cycle: number;
  readonly network: string;
  readonly protocolHash: string;
  readonly distributionStatus: DistributionSnapshot['distribution']['status'];
  /** K as it was applied, e.g. `3` or `1.5`. */
  readonly payoutFactor: string;
  readonly feeRate: string;

  readonly poolMutez: Mutez;
  readonly ownShareMutez: Mutez;
  readonly bakerFeeMutez: Mutez;
  readonly distributableMutez: Mutez;
  readonly remainderMutez: Mutez;

  readonly paidMutez: Mutez;
  /** Σ of the debt every delegator leaves this cycle with. */
  readonly debtMutez: Mutez;

  readonly delegatorCount: number;
  readonly paidCount: number;
  readonly belowCutCount: number;

  readonly rows: readonly CycleReportRow[];
}

export function buildCycleReport(snapshot: DistributionSnapshot): CycleReport {
  const { distribution, lines } = snapshot;
  const opHashByAddress = new Map(lines.map((line) => [line.address, line.opHash]));

  const rows = lines
    .map((line): CycleReportRow => ({
      address: line.address,
      delegatedBalanceMutez: line.delegatedBalanceMutez,
      grossMutez: line.grossMutez,
      commissionMutez: line.commissionMutez,
      owedThisCycleMutez: line.netMutez,
      carriedInMutez: line.carriedInMutez,
      payableMutez: line.payableMutez,
      transferCostMutez: line.transferCostMutez,
      cutMutez: line.minimumMutez,
      paidMutez: line.result === 'applied' ? line.amountMutez : 0n,
      debtMutez: debtOf(line),
      status: statusOf(line),
      opHash: opHashByAddress.get(line.address) ?? null,
    }))
    // Stable and readable: biggest debt first, then by address so two rows
    // never swap places between two renderings of the same cycle.
    .sort((a, b) =>
      a.debtMutez === b.debtMutez
        ? a.address.localeCompare(b.address)
        : b.debtMutez > a.debtMutez
          ? 1
          : -1,
    );

  const report: CycleReport = {
    bakerId: distribution.bakerId,
    cycle: distribution.cycle,
    network: distribution.network,
    protocolHash: distribution.protocolHash,
    distributionStatus: distribution.status,
    payoutFactor: formatPayoutFactor({
      numerator: distribution.payoutFactorNumerator,
      denominator: distribution.payoutFactorDenominator,
    } satisfies PayoutFactor),
    feeRate: `${distribution.feeNumerator}/${distribution.feeDenominator}`,
    poolMutez: distribution.pool,
    ownShareMutez: distribution.ownShare,
    bakerFeeMutez: distribution.bakerFee,
    distributableMutez: distribution.distributable,
    remainderMutez: distribution.remainder,
    paidMutez: sumMutez(rows.map((row) => row.paidMutez)),
    debtMutez: sumMutez(rows.map((row) => row.debtMutez)),
    delegatorCount: rows.length,
    paidCount: rows.filter((row) => row.status === 'paid').length,
    belowCutCount: rows.filter((row) => row.status === 'below-cut').length,
    rows,
  };

  assertReportComplete(report, snapshot);
  return report;
}

/**
 * The check that can fail.
 *
 * Two things it will not let through, both of which are the rule quietly
 * turning into "make the small ones disappear": a delegator who has a line
 * but no row, and a report whose paid + debt does not account for everything
 * that was payable.
 */
export function assertReportComplete(
  report: CycleReport,
  snapshot: DistributionSnapshot,
): void {
  if (report.rows.length !== snapshot.lines.length) {
    throw new InvariantViolationError(
      'one report row per delegator line',
      `${report.bakerId} cycle ${report.cycle}: ${snapshot.lines.length} lines produced ` +
        `${report.rows.length} rows`,
    );
  }
  const missing = snapshot.lines.filter(
    (line) => !report.rows.some((row) => row.address === line.address),
  );
  if (missing.length > 0) {
    throw new InvariantViolationError(
      'every delegator appears in the report of every cycle',
      `${report.bakerId} cycle ${report.cycle} hides ${missing.map((l) => l.address).join(', ')}`,
    );
  }
  for (const row of report.rows) {
    if (row.paidMutez + row.debtMutez !== row.payableMutez) {
      throw new InvariantViolationError(
        'paid + debt == payable, per delegator',
        `${row.address}: ${row.paidMutez} + ${row.debtMutez} != ${row.payableMutez}`,
      );
    }
  }
}

export interface OpenDebtRow {
  readonly address: string;
  readonly debtMutez: Mutez;
}

export interface OpenDebtReport {
  readonly bakerId: string;
  readonly rows: readonly OpenDebtRow[];
  readonly totalMutez: Mutez;
}

/**
 * Everything the baker still owes, across all cycles.
 *
 * This is the list a human reads before asking for a settlement (RN-24,
 * borda 1): a delegator who stopped delegating stays on it for ever, because
 * their debt does not grow, does not clear the cut on its own, and does not
 * expire because they went quiet.
 */
export function buildOpenDebtReport(
  bakerId: string,
  carryOver: ReadonlyMap<string, Mutez>,
): OpenDebtReport {
  const rows = [...carryOver.entries()]
    .map(([address, debtMutez]) => ({ address, debtMutez }))
    .sort((a, b) =>
      a.debtMutez === b.debtMutez
        ? a.address.localeCompare(b.address)
        : b.debtMutez > a.debtMutez
          ? 1
          : -1,
    );
  return { bakerId, rows, totalMutez: sumMutez(rows.map((row) => row.debtMutez)) };
}

function debtOf(line: DelegatorLineRecord): Mutez {
  // `carriedOutMutez` is what the plan said would roll over. It is right for
  // everything except a batch that did not land: there the money is still
  // owed, whatever the plan intended.
  return line.result === 'applied' ? line.carriedOutMutez : line.payableMutez;
}

function statusOf(line: DelegatorLineRecord): RowStatus {
  if (line.result === 'applied') return 'paid';
  if (line.payableMutez === 0n) return 'zero';
  return line.amountMutez > 0n ? 'unpaid' : 'below-cut';
}

/** Plain text, for a terminal or an e-mail. Mutez, never a float XTZ. */
export function formatCycleReport(report: CycleReport): string {
  const header =
    `${report.bakerId} cycle ${report.cycle} (${report.network}, ${report.distributionStatus})\n` +
    `  fee ${report.feeRate}, K ${report.payoutFactor}\n` +
    `  pool ${report.poolMutez} | own ${report.ownShareMutez} | commission ${report.bakerFeeMutez} ` +
    `| remainder ${report.remainderMutez}\n` +
    `  paid ${report.paidMutez} mutez to ${report.paidCount}/${report.delegatorCount}; ` +
    `${report.belowCutCount} below the cut carrying ${report.debtMutez} mutez\n`;

  const rows = report.rows.map(
    (row) =>
      `  ${row.address}  owed ${row.owedThisCycleMutez}  carried-in ${row.carriedInMutez}  ` +
      `cut ${row.cutMutez}  paid ${row.paidMutez}  debt ${row.debtMutez}  [${row.status}]`,
  );
  return `${header}${rows.join('\n')}`;
}

export type { LineResult };
