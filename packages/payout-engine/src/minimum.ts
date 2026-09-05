import { ConfigurationError, type Mutez, type MinimumPayoutContext } from '@tezos-suite/chain';
import { InvalidPayoutFactorError, MissingEstimateError } from './errors';

/**
 * The cut: a payment enters the batch only when what is owed covers K times
 * the estimated cost of that very transfer (RN-24).
 *
 * Two properties, and both matter:
 *
 * - It is RELATIVE. The cost comes from `estimate.batch()` at distribution
 *   time, plus the allocation burn when the destination has to be created.
 *   Writing the measured 477 mutez into the code would repeat exactly the
 *   mistake this engine exists to remove: 477 was the median of 5957
 *   transfers on one day, the mean was 543, and the fee moves with demand.
 * - K is the baker's, not ours. Order of magnitude on the reference baker
 *   (cycle 1336, 2919 delegators): with no cut, 4.50% of the pool becomes
 *   network fees; at K = 1, 1.82%. Raising K pushes that down further and
 *   makes the small delegator wait more cycles for a larger payment. Which
 *   trade the baker wants is the baker's call, measured on their own pool.
 *
 * What is below the cut is NOT discarded: it is the baker's debt to that
 * delegator, it accumulates across cycles, and it is paid the moment it
 * clears. That half lives in `computePayout` and is proved by the property
 * test `paid + open debt == owed`.
 */

/**
 * K, as an integer ratio. Never a float: a cut applied every cycle to every
 * delegator does not get to drift, and 1.1 is not representable in binary.
 */
export interface PayoutFactor {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * K below 1 would admit a payment worth less than the transfer that carries
 * it — the baker burning their own money to move dust, which is the thing
 * RN-24 exists to stop. It is refused rather than clamped: a baker who typed
 * 0.5 meant something, and silently reading it as 1 answers a question they
 * did not ask.
 */
export function payoutFactor(numerator: bigint, denominator: bigint): PayoutFactor {
  if (denominator <= 0n) {
    throw new InvalidPayoutFactorError(numerator, denominator, 'the denominator must be > 0');
  }
  if (numerator < denominator) {
    throw new InvalidPayoutFactorError(
      numerator,
      denominator,
      'K < 1 would pay out less than the transfer costs',
    );
  }
  return { numerator, denominator };
}

/** For messages and for the audit trail: `3`, `1.5`, `7/4`. */
export function formatPayoutFactor(factor: PayoutFactor): string {
  if (factor.denominator === 1n) return factor.numerator.toString();
  return `${factor.numerator}/${factor.denominator}`;
}

const FACTOR_ENV = 'TAPS_PAYOUT_MIN_FACTOR';

/**
 * Reads K from the environment as an exact decimal, never through `Number`.
 * `"3"` is 3/1 and `"1.5"` is 15/10; both stay integers all the way down.
 *
 * There is no default. K decides who is paid this cycle and who waits, and a
 * K nobody chose is a policy nobody chose.
 */
export function loadPayoutFactor(env: NodeJS.ProcessEnv = process.env): PayoutFactor {
  const raw = env[FACTOR_ENV];
  if (!raw || raw.trim() === '') {
    throw new ConfigurationError(
      `${FACTOR_ENV} is not set — RN-24 pays only what covers K times the estimated ` +
        'transfer cost, and K is the baker\'s choice; set it (e.g. "3" or "1.5")',
    );
  }
  return parsePayoutFactor(raw.trim(), FACTOR_ENV);
}

/** `"3"`, `"1.5"`, `"2.25"` → an exact ratio. Anything else raises. */
export function parsePayoutFactor(text: string, source = 'K'): PayoutFactor {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) {
    throw new ConfigurationError(
      `${source} must be a non-negative decimal with at most 6 decimal places, ` +
        `got ${JSON.stringify(text)}`,
    );
  }
  const [, whole, fraction = ''] = match;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);
  return payoutFactor(numerator, denominator);
}

export interface EstimatedCosts {
  /** Estimated fee per destination, from this run's `estimate.batch()`. */
  readonly feeByAddress: ReadonlyMap<string, Mutez>;
  /** `origination_size * cost_per_byte`, read from the chain this run. */
  readonly allocationBurn: Mutez;
  /** K: how many times the transfer cost the payment has to cover. */
  readonly factor: PayoutFactor;
}

/**
 * What it costs to pay this delegator once: the fee this run estimated for
 * this very transfer, plus the allocation burn when the destination has to be
 * created.
 *
 * An address the estimation pass never covered raises. There is deliberately
 * no fallback value to reach for — a fallback here is a written-down fee by
 * another name, and it would silently exclude or include the wrong people.
 */
export function transferCost(
  costs: EstimatedCosts,
  address: string,
  emptied: boolean,
): Mutez {
  const fee = costs.feeByAddress.get(address);
  if (fee === undefined) throw new MissingEstimateError(address);
  return fee + (emptied ? costs.allocationBurn : 0n);
}

/**
 * K × cost, rounded UP.
 *
 * Rounding up rather than down because the cut is a floor on what is worth
 * sending: at K = 1 the rounding is exact anyway, and at K = 1.5 against a
 * 477 mutez transfer, rounding down would let 715 through when the rule says
 * 716. Integer division on bigint, so no `Math.ceil` and no float.
 */
export function applyPayoutFactor(cost: Mutez, factor: PayoutFactor): Mutez {
  const scaled = cost * factor.numerator;
  const { denominator } = factor;
  return (scaled + denominator - 1n) / denominator;
}

/**
 * Builds the per-delegator cut used by `computePayout`.
 */
export function makeMinimumPayout(
  costs: EstimatedCosts,
): (context: MinimumPayoutContext) => Mutez {
  return (context) => {
    // Nothing owed, nothing to compare: a delegator whose share floored to
    // zero is not paid whatever the cut is, and pricing a transfer that will
    // never exist would only make the estimation pass larger.
    if (context.payable <= 0n) return 0n;

    return applyPayoutFactor(
      transferCost(costs, context.address, context.emptied),
      costs.factor,
    );
  };
}
