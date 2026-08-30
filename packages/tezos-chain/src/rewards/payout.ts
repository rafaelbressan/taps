import { assertPayableAddress } from '../address';
import { InvariantViolationError } from '../errors';
import type { Mutez } from '../mutez';
import { sumMutez } from '../mutez';
import {
  REWARD_EVENTS,
  assertDelegatorListComplete,
  type RewardSplit,
} from '../tzkt/reward-split';

/**
 * The baker's commission, as an integer ratio. Never a float: 0.1 is not
 * representable in binary, and a rounding error in a fee applied every cycle
 * to every delegator does not cancel out.
 */
export interface FeeRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function feeRate(numerator: bigint, denominator: bigint): FeeRate {
  if (denominator <= 0n) {
    throw new InvariantViolationError('fee denominator > 0', `got ${denominator}`);
  }
  if (numerator < 0n || numerator > denominator) {
    throw new InvariantViolationError(
      '0 <= fee numerator <= denominator',
      `got ${numerator}/${denominator}`,
    );
  }
  return { numerator, denominator };
}

export interface PayoutCandidate {
  readonly address: string;
  readonly delegatedBalance: Mutez;
  /** The destination needs a storage allocation, and its burn, to be paid. */
  readonly emptied: boolean;
  /** This cycle's share, before the minimum is applied. */
  readonly cycleAmount: Mutez;
  /** Unpaid balance carried in from earlier cycles. */
  readonly carriedIn: Mutez;
  /** cycleAmount + carriedIn — what would actually be sent. */
  readonly payable: Mutez;
}

export interface PayoutEntry extends PayoutCandidate {
  /** False when `payable` did not clear this delegator's own minimum. */
  readonly paid: boolean;
  /** The minimum applied, in mutez, for the record. */
  readonly minimum: Mutez;
  /** What rolls into the next cycle. Debt to the delegator, not a discard. */
  readonly carriedOut: Mutez;
}

export interface PayoutPlan {
  readonly baker: string;
  readonly cycle: number;

  /** Σ of the five `*Delegated` fields (+ blockFees when the policy includes them). */
  readonly pool: Mutez;
  readonly blockFeesIncluded: boolean;

  /** The part matching the baker's own delegated balance. Stays with the baker. */
  readonly ownShare: Mutez;
  /** Commission on the external part. */
  readonly bakerFee: Mutez;
  /** External gross minus commission — what the delegators split. */
  readonly distributable: Mutez;
  /** Floor-division leftover. Stays with the baker; no mutez is invented. */
  readonly remainder: Mutez;

  readonly entries: readonly PayoutEntry[];
  readonly toPay: readonly PayoutEntry[];
  readonly deferred: readonly PayoutEntry[];

  /** Σ of what will actually be sent this run (includes carried-in balances). */
  readonly totalToSend: Mutez;

  /**
   * Rewards the protocol already credited to stakers, and the baker's own
   * frozen parts. Reported so an operator can see them; never distributed.
   */
  readonly alreadySettled: {
    readonly stakedShared: Mutez;
    readonly stakedOwn: Mutez;
    readonly stakedEdge: Mutez;
  };
}

export interface MinimumPayoutContext {
  readonly address: string;
  readonly emptied: boolean;
  readonly payable: Mutez;
}

export interface ComputePayoutOptions {
  readonly split: RewardSplit;
  readonly fee: FeeRate;
  /** Block fees are the baker's policy: include them in the pool or not. */
  readonly includeBlockFees?: boolean;
  /** Unpaid balances from earlier cycles, keyed by delegator address. */
  readonly carryIn?: ReadonlyMap<string, Mutez>;
  /**
   * The minimum this delegator must clear to be paid this cycle. It is the
   * estimated fee for *this* transfer, taken from `estimate.batch()` at
   * distribution time, plus the allocation burn when the destination is
   * emptied — not a constant. Writing `MIN_PAYOUT = 477` would repeat the
   * exact mistake this package exists to remove: the fee moves with demand.
   *
   * Omitted means "pay every non-zero amount".
   */
  readonly minimumPayout?: (context: MinimumPayoutContext) => Mutez;
  /** Skip address validation only in tests that use synthetic addresses. */
  readonly validateAddresses?: boolean;
}

function poolOf(split: RewardSplit, includeBlockFees: boolean): Mutez {
  // Only `*Delegated` lands on the baker's liquid balance. StakedShared was
  // credited to the stakers by the protocol; StakedOwn and StakedEdge are the
  // baker's own frozen rewards. Paying any of the three pays twice.
  let pool = sumMutez(REWARD_EVENTS.map((event) => split.rewards[`${event}Delegated`]));
  if (includeBlockFees) pool += split.blockFees;
  return pool;
}

export function computePayout(options: ComputePayoutOptions): PayoutPlan {
  const {
    split,
    fee,
    includeBlockFees = false,
    carryIn,
    minimumPayout,
    validateAddresses = true,
  } = options;

  // A truncated delegator list is the failure that pays the wrong people the
  // wrong amounts without raising anything. Check before doing arithmetic.
  assertDelegatorListComplete(split);

  const pool = poolOf(split, includeBlockFees);
  const base = split.ownDelegatedBalance + split.externalDelegatedBalance;
  if (base <= 0n) {
    throw new InvariantViolationError(
      'ownDelegatedBalance + externalDelegatedBalance > 0',
      `${split.baker} cycle ${split.cycle} reported ${base}`,
    );
  }

  const ownShare = (pool * split.ownDelegatedBalance) / base;
  const externalGross = pool - ownShare;
  const bakerFee = (externalGross * fee.numerator) / fee.denominator;
  const distributable = externalGross - bakerFee;

  const external = split.externalDelegatedBalance;
  const entries: PayoutEntry[] = [];
  let distributed = 0n;

  for (const delegator of split.delegators) {
    if (validateAddresses) assertPayableAddress(delegator.address);

    const cycleAmount =
      external > 0n ? (distributable * delegator.delegatedBalance) / external : 0n;
    distributed += cycleAmount;

    const carriedIn = carryIn?.get(delegator.address) ?? 0n;
    const payable = cycleAmount + carriedIn;

    const minimum =
      minimumPayout?.({
        address: delegator.address,
        emptied: delegator.emptied,
        payable,
      }) ?? 0n;

    const paid = payable > 0n && payable > minimum;
    entries.push({
      address: delegator.address,
      delegatedBalance: delegator.delegatedBalance,
      emptied: delegator.emptied,
      cycleAmount,
      carriedIn,
      payable,
      minimum,
      paid,
      carriedOut: paid ? 0n : payable,
    });
  }

  const remainder = distributable - distributed;
  const closes = ownShare + bakerFee + distributed + remainder;
  if (closes !== pool) {
    throw new InvariantViolationError(
      'ownShare + bakerFee + sum(cycleAmount) + remainder == pool',
      `${split.baker} cycle ${split.cycle}: ${closes} != ${pool}`,
    );
  }
  if (remainder < 0n) {
    throw new InvariantViolationError(
      'remainder >= 0',
      `${split.baker} cycle ${split.cycle}: distributed ${distributed} exceeds ${distributable}`,
    );
  }

  const toPay = entries.filter((entry) => entry.paid);
  const deferred = entries.filter((entry) => !entry.paid && entry.payable > 0n);

  return {
    baker: split.baker,
    cycle: split.cycle,
    pool,
    blockFeesIncluded: includeBlockFees,
    ownShare,
    bakerFee,
    distributable,
    remainder,
    entries,
    toPay,
    deferred,
    totalToSend: sumMutez(toPay.map((entry) => entry.payable)),
    alreadySettled: {
      stakedShared: sumMutez(
        REWARD_EVENTS.map((event) => split.rewards[`${event}StakedShared`]),
      ),
      stakedOwn: sumMutez(REWARD_EVENTS.map((event) => split.rewards[`${event}StakedOwn`])),
      stakedEdge: sumMutez(
        REWARD_EVENTS.map((event) => split.rewards[`${event}StakedEdge`]),
      ),
    },
  };
}

/** The balances to persist and feed back into the next cycle's `carryIn`. */
export function carryOutOf(plan: PayoutPlan): Map<string, Mutez> {
  const carry = new Map<string, Mutez>();
  for (const entry of plan.deferred) {
    if (entry.carriedOut > 0n) carry.set(entry.address, entry.carriedOut);
  }
  return carry;
}
