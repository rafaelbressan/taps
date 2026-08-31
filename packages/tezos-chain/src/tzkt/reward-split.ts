import { InvariantViolationError } from '../errors';
import type { Mutez } from '../mutez';
import { sumMutez } from '../mutez';
import type { ProtocolConstants } from '../rpc/protocol-constants';
import {
  requireArray,
  requireBoolean,
  requireInteger,
  requireMutez,
  requireObject,
  requireString,
} from './fields';
import type { TzKTHttp } from './http';

/**
 * `/v1/rewards/split/{baker}/{cycle}` is the only endpoint that carries the
 * cycle *snapshot* balances, which is what a payout must be computed on.
 *
 * `/v1/delegates/{id}/delegators` does not exist (404). The real lister is
 * `/v1/accounts/{address}/delegators`, and it reports balances as of now —
 * useful for a dashboard, wrong for a payout.
 */

/** Every reward-bearing event. `endorsement*` are DEPRECATED aliases of `attestation*`. */
export const REWARD_EVENTS = [
  'blockRewards',
  'attestationRewards',
  'dalAttestationRewards',
  'vdfRevelationRewards',
  'nonceRevelationRewards',
] as const;
export type RewardEvent = (typeof REWARD_EVENTS)[number];

/**
 * Where each reward landed.
 *
 *   Delegated    on the baker's liquid balance — the only pool to distribute
 *   StakedOwn    the baker's own stake, frozen, already theirs
 *   StakedEdge   the baker's edge on external stake, already theirs
 *   StakedShared the stakers' share — ALREADY CREDITED BY THE PROTOCOL
 *
 * Paying StakedShared is paying twice.
 */
export const REWARD_DESTINATIONS = [
  'Delegated',
  'StakedOwn',
  'StakedEdge',
  'StakedShared',
] as const;
export type RewardDestination = (typeof REWARD_DESTINATIONS)[number];

export type RewardFieldName = `${RewardEvent}${RewardDestination}`;

export function rewardFieldNames(): RewardFieldName[] {
  return REWARD_EVENTS.flatMap((event) =>
    REWARD_DESTINATIONS.map((destination) => `${event}${destination}` as RewardFieldName),
  );
}

export interface SplitDelegator {
  readonly address: string;
  /** Snapshot balance for the cycle, in mutez. */
  readonly delegatedBalance: Mutez;
  /**
   * TzKT: "Emptied accounts (users with zero balance) should be re-allocated."
   * An emptied destination needs storage in the batch, or the whole batch
   * comes back `backtracked`.
   */
  readonly emptied: boolean;
}

export interface SplitStaker {
  readonly address: string;
  readonly stakedBalance: Mutez;
}

export interface SplitActualStaker {
  readonly address: string;
  readonly initialStake: Mutez;
  readonly finalStake: Mutez;
  /** Credited by the protocol during the cycle. Never paid by the baker. */
  readonly rewards: Mutez;
}

export interface RewardSplit {
  readonly baker: string;
  readonly cycle: number;

  readonly ownDelegatedBalance: Mutez;
  readonly externalDelegatedBalance: Mutez;
  readonly ownStakedBalance: Mutez;
  readonly externalStakedBalance: Mutez;

  readonly delegatorsCount: number;
  readonly stakersCount: number;

  readonly bakingPower: Mutez;
  readonly totalBakingPower: Mutez;

  readonly blockFees: Mutez;
  readonly futureBlocks: number;

  readonly rewards: Readonly<Record<RewardFieldName, Mutez>>;

  readonly delegators: readonly SplitDelegator[];
  readonly stakers: readonly SplitStaker[];
  readonly actualStakers: readonly SplitActualStaker[];
}

/** Hard ceiling enforced by the API: `limit=10001` answers HTTP 400. */
export const TZKT_MAX_PAGE_SIZE = 10_000;

export interface FetchRewardSplitOptions {
  readonly pageSize?: number;
  /** Bounds a runaway loop; 60 258 delegators is 7 pages, not 1000. */
  readonly maxPages?: number;
}

function parseDelegator(value: unknown, where: string): SplitDelegator {
  const row = requireObject(value, where);
  return {
    address: requireString(row, 'address', where),
    delegatedBalance: requireMutez(row, 'delegatedBalance', where),
    emptied: requireBoolean(row, 'emptied', where),
  };
}

function parseStaker(value: unknown, where: string): SplitStaker {
  const row = requireObject(value, where);
  return {
    address: requireString(row, 'address', where),
    stakedBalance: requireMutez(row, 'stakedBalance', where),
  };
}

function parseActualStaker(value: unknown, where: string): SplitActualStaker {
  const row = requireObject(value, where);
  return {
    address: requireString(row, 'address', where),
    initialStake: requireMutez(row, 'initialStake', where),
    finalStake: requireMutez(row, 'finalStake', where),
    rewards: requireMutez(row, 'rewards', where),
  };
}

/**
 * Builds a `RewardSplit` from one or more raw pages. Scalars come from the
 * first page; the arrays are the concatenation, in order.
 */
export function parseRewardSplit(
  pages: readonly Record<string, unknown>[],
  baker: string,
  cycle: number,
): RewardSplit {
  const first = pages[0];
  if (!first) {
    throw new InvariantViolationError(
      'reward split has at least one page',
      `no page returned for ${baker} cycle ${cycle}`,
    );
  }
  const where = `/v1/rewards/split/${baker}/${cycle}`;

  const rewards = {} as Record<RewardFieldName, Mutez>;
  for (const field of rewardFieldNames()) {
    rewards[field] = requireMutez(first, field, where);
  }

  const delegators: SplitDelegator[] = [];
  const stakers: SplitStaker[] = [];
  const actualStakers: SplitActualStaker[] = [];
  for (const page of pages) {
    for (const row of requireArray(page, 'delegators', where)) {
      delegators.push(parseDelegator(row, `${where} delegators[]`));
    }
    for (const row of requireArray(page, 'stakers', where)) {
      stakers.push(parseStaker(row, `${where} stakers[]`));
    }
    for (const row of requireArray(page, 'actualStakers', where)) {
      actualStakers.push(parseActualStaker(row, `${where} actualStakers[]`));
    }
  }

  return {
    baker,
    cycle: requireInteger(first, 'cycle', where),
    ownDelegatedBalance: requireMutez(first, 'ownDelegatedBalance', where),
    externalDelegatedBalance: requireMutez(first, 'externalDelegatedBalance', where),
    ownStakedBalance: requireMutez(first, 'ownStakedBalance', where),
    externalStakedBalance: requireMutez(first, 'externalStakedBalance', where),
    delegatorsCount: requireInteger(first, 'delegatorsCount', where),
    stakersCount: requireInteger(first, 'stakersCount', where),
    bakingPower: requireMutez(first, 'bakingPower', where),
    totalBakingPower: requireMutez(first, 'totalBakingPower', where),
    blockFees: requireMutez(first, 'blockFees', where),
    futureBlocks: requireInteger(first, 'futureBlocks', where),
    rewards: Object.freeze(rewards),
    delegators,
    stakers,
    actualStakers,
  };
}

/**
 * Fetches every page. The default page size is 100 and the maximum is 10 000;
 * Everstake had 60 258 delegators in cycle 1336, so "read the first page" is
 * not an edge case, it is the ordinary case for any large baker — and it
 * fails silently, overpaying the 10 000 listed and paying zero to the rest.
 */
export async function fetchRewardSplit(
  http: TzKTHttp,
  baker: string,
  cycle: number,
  options: FetchRewardSplitOptions = {},
): Promise<RewardSplit> {
  const pageSize = Math.min(options.pageSize ?? TZKT_MAX_PAGE_SIZE, TZKT_MAX_PAGE_SIZE);
  const maxPages = options.maxPages ?? 1_000;

  const pages: Record<string, unknown>[] = [];
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const { body } = await http.getRequired<Record<string, unknown>>(
      `/v1/rewards/split/${baker}/${cycle}`,
      { limit: pageSize, offset: pageIndex * pageSize },
    );
    const where = `/v1/rewards/split/${baker}/${cycle} page ${pageIndex}`;
    pages.push(body);

    // `offset` shifts delegators, stakers and actualStakers together. Only
    // stop once no array could still have a next page.
    const stillFull =
      requireArray(body, 'delegators', where).length === pageSize ||
      requireArray(body, 'stakers', where).length === pageSize ||
      requireArray(body, 'actualStakers', where).length === pageSize;
    if (!stillFull) {
      return parseRewardSplit(pages, baker, cycle);
    }
  }

  throw new InvariantViolationError(
    'pagination terminates',
    `${baker} cycle ${cycle} still returned full pages after ${maxPages} pages of ${pageSize}`,
  );
}

/**
 * The check that can actually fail.
 *
 * The sum of the listed delegator balances equals `externalDelegatedBalance`
 * exactly when the list is complete, and does not when it is truncated. With
 * a truncated list there is no error anywhere else: the distribution simply
 * overpays whoever was listed and pays nothing to whoever was not.
 *
 * Run this before building any batch. If it fails, abort.
 */
export function assertDelegatorListComplete(split: RewardSplit): void {
  const listed = sumMutez(split.delegators.map((d) => d.delegatedBalance));
  if (listed !== split.externalDelegatedBalance) {
    const missing = split.externalDelegatedBalance - listed;
    throw new InvariantViolationError(
      'sum(delegators[].delegatedBalance) == externalDelegatedBalance',
      `${split.baker} cycle ${split.cycle}: listed ${split.delegators.length} delegators ` +
        `totalling ${listed} mutez against externalDelegatedBalance ${split.externalDelegatedBalance} ` +
        `(${missing} mutez unaccounted for) — the delegator list is truncated`,
    );
  }
  if (split.delegators.length !== split.delegatorsCount) {
    throw new InvariantViolationError(
      'delegators.length == delegatorsCount',
      `${split.baker} cycle ${split.cycle}: got ${split.delegators.length} of ${split.delegatorsCount}`,
    );
  }
}

/**
 * `bakingPower == ownStaked + externalStaked + delegated / edge_of_staking_over_delegation`,
 * with the edge read from the chain. If this does not close, the reading of
 * the economic model is wrong and nothing downstream should be trusted.
 */
export function assertBakingPowerConsistent(
  split: RewardSplit,
  constants: ProtocolConstants,
): void {
  const edge = BigInt(constants.edgeOfStakingOverDelegation);
  if (edge <= 0n) {
    throw new InvariantViolationError(
      'edge_of_staking_over_delegation > 0',
      `chain reported ${constants.edgeOfStakingOverDelegation}`,
    );
  }
  const delegated = split.ownDelegatedBalance + split.externalDelegatedBalance;
  const expected = split.ownStakedBalance + split.externalStakedBalance + delegated / edge;
  if (expected !== split.bakingPower) {
    throw new InvariantViolationError(
      'bakingPower == staked + delegated / edge_of_staking_over_delegation',
      `${split.baker} cycle ${split.cycle}: computed ${expected}, reported ${split.bakingPower} ` +
        `(edge ${edge} read from ${constants.protocolHash})`,
    );
  }
}

/** The cycle is closed once no block of it is still in the future. */
export function isCycleClosed(split: RewardSplit): boolean {
  return split.futureBlocks === 0;
}
