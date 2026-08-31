import type { Mutez, MinimumPayoutContext } from '@tezos-suite/chain';
import { MissingEstimateError } from './errors';

/**
 * The minimum payment.
 *
 * Decided on 2026-08-30: the minimum is the network fee of the transfer
 * itself, and anything below it accumulates to the next cycle.
 *
 * It is therefore NOT a constant. It comes from `estimate.batch()` at
 * distribution time, plus the allocation burn when the destination has to be
 * created. Writing the measured 477 mutez into the code would repeat exactly
 * the mistake this engine exists to remove: 477 was the median of 5957
 * transfers on one day, the mean was 543, and the fee moves with demand.
 *
 * Order of magnitude on the reference baker (cycle 1336, 2919 delegators):
 * with no floor, 63% of them would receive no more than the cost of paying
 * them, and 4.50% of the pool would become network fees. With the floor at
 * one fee, 1.82%.
 */

export interface EstimatedCosts {
  /** Estimated fee per destination, from this run's `estimate.batch()`. */
  readonly feeByAddress: ReadonlyMap<string, Mutez>;
  /** `origination_size * cost_per_byte`, read from the chain this run. */
  readonly allocationBurn: Mutez;
  /**
   * The baker's own floor, in mutez. May be higher than the estimated fee,
   * never lower: a floor below the fee would pay out less than it costs.
   */
  readonly bakerFloor: Mutez;
}

/**
 * Builds the per-delegator minimum used by `computePayout`.
 *
 * An address the estimation pass never covered raises. There is deliberately
 * no fallback value to reach for — a fallback here is a written-down fee by
 * another name, and it would silently exclude or include the wrong people.
 */
export function makeMinimumPayout(
  costs: EstimatedCosts,
): (context: MinimumPayoutContext) => Mutez {
  return (context) => {
    // Nothing owed, nothing to compare: a delegator whose share floored to
    // zero is not paid whatever the cut is, and pricing a transfer that will
    // never exist would only make the estimation pass larger.
    if (context.payable <= 0n) return 0n;

    const fee = costs.feeByAddress.get(context.address);
    if (fee === undefined) throw new MissingEstimateError(context.address);
    const transferCost = fee + (context.emptied ? costs.allocationBurn : 0n);
    return transferCost > costs.bakerFloor ? transferCost : costs.bakerFloor;
  };
}
