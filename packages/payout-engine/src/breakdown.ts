import {
  InvariantViolationError,
  type FeeRate,
  type Mutez,
  type PayoutPlan,
  type RewardSplit,
} from '@tezos-suite/chain';

/**
 * The per-delegator decomposition, recorded AT DISTRIBUTION TIME.
 *
 * The reason it cannot be recomputed later is the last field: the cut applied
 * this cycle is the estimated fee of that cycle's transfer, and the network
 * fee moves. Once the cycle is over, nothing on the chain says what the
 * estimate was — so without writing it down, nobody can ever say truthfully
 * why a given delegator received a given amount in a past cycle.
 */
export interface DelegatorLine {
  readonly address: string;
  readonly delegatedBalance: Mutez;
  readonly emptied: boolean;

  /** Before the commission, in mutez. */
  readonly gross: Mutez;
  /** Commission withheld by the baker, in mutez. */
  readonly commission: Mutez;
  /** `gross - commission`: this cycle's share. */
  readonly net: Mutez;

  /** Balance carried in from earlier cycles. */
  readonly carriedIn: Mutez;
  /** `net + carriedIn` — the amount compared against the cut. */
  readonly payable: Mutez;

  /** The cut applied this cycle, in mutez. Not reproducible afterwards. */
  readonly minimum: Mutez;
  /** Withheld for being at or below the cut. Debt, not a discard. */
  readonly withheld: Mutez;

  /** What enters the batch. Zero when below the cut. */
  readonly amount: Mutez;
  /** What rolls into the next cycle. */
  readonly carriedOut: Mutez;

  readonly paid: boolean;
  readonly reason: 'paid' | 'below-cut' | 'zero';
}

/**
 * Per-delegator gross and commission.
 *
 * `computePayout` takes the commission off the pool once, not per delegator,
 * so the split is reconstructed here from the same balance and the same
 * integer division. Per line it is exact: `gross == commission + net`, and
 * `commission` is precisely what that delegator lost to the fee, which is
 * what a statement has to answer.
 *
 * Their SUM cannot equal the pool-level `bakerFee` to the last mutez — two
 * floor divisions per line drift by less than one mutez each, so the total
 * drifts by at most one mutez per delegator. The authoritative amount the
 * baker retains stays `bakerFee + remainder`; the per-line column is not a
 * second way to compute it.
 */
export function buildDelegatorLines(
  split: RewardSplit,
  plan: PayoutPlan,
  fee: FeeRate,
): DelegatorLine[] {
  const external = split.externalDelegatedBalance;
  const externalGross = plan.pool - plan.ownShare;

  const lines = plan.entries.map((entry): DelegatorLine => {
    const gross =
      external > 0n ? (externalGross * entry.delegatedBalance) / external : 0n;
    const net = entry.cycleAmount;
    const commission = gross - net;

    if (commission < 0n) {
      throw new InvariantViolationError(
        'commission >= 0 for every delegator',
        `${entry.address}: gross ${gross} is below net ${net}`,
      );
    }

    const amount = entry.paid ? entry.payable : 0n;
    const withheld = entry.paid ? 0n : entry.payable;
    return {
      address: entry.address,
      delegatedBalance: entry.delegatedBalance,
      emptied: entry.emptied,
      gross,
      commission,
      net,
      carriedIn: entry.carriedIn,
      payable: entry.payable,
      minimum: entry.minimum,
      withheld,
      amount,
      carriedOut: entry.carriedOut,
      paid: entry.paid,
      reason: entry.payable === 0n ? 'zero' : entry.paid ? 'paid' : 'below-cut',
    };
  });

  assertLinesClose(lines, plan);
  return lines;
}

/**
 * The check that can fail. Written as an identity over values the lines carry
 * independently of each other, not as a restatement of how they were built.
 */
export function assertLinesClose(
  lines: readonly DelegatorLine[],
  plan: PayoutPlan,
): void {
  let sent = 0n;
  for (const line of lines) {
    if (line.gross !== line.commission + line.net) {
      throw new InvariantViolationError(
        'gross == commission + net',
        `${line.address}: ${line.gross} != ${line.commission} + ${line.net}`,
      );
    }
    if (line.amount + line.carriedOut !== line.payable) {
      throw new InvariantViolationError(
        'amount + carriedOut == payable',
        `${line.address}: ${line.amount} + ${line.carriedOut} != ${line.payable}`,
      );
    }
    if (line.withheld !== (line.paid ? 0n : line.payable)) {
      throw new InvariantViolationError(
        'withheld == payable when unpaid, 0 when paid',
        `${line.address}: withheld ${line.withheld}, paid ${line.paid}, payable ${line.payable}`,
      );
    }
    if (line.paid && line.payable <= line.minimum) {
      throw new InvariantViolationError(
        'a paid delegator cleared the cut',
        `${line.address}: payable ${line.payable} does not clear cut ${line.minimum}`,
      );
    }
    if (line.gross < 0n || line.amount < 0n || line.carriedOut < 0n) {
      throw new InvariantViolationError(
        'no negative amount on a delegator line',
        `${line.address}: gross ${line.gross}, amount ${line.amount}, carriedOut ${line.carriedOut}`,
      );
    }
    sent += line.amount;
  }
  if (sent !== plan.totalToSend) {
    throw new InvariantViolationError(
      'sum(line.amount) == plan.totalToSend',
      `lines total ${sent}, plan says ${plan.totalToSend}`,
    );
  }
}
