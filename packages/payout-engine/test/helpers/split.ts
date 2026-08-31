import {
  rewardFieldNames,
  sumMutez,
  type Mutez,
  type RewardFieldName,
  type RewardSplit,
  type SplitDelegator,
} from '@tezos-suite/chain';

/**
 * A reward split with the shape the TzKT endpoint really returns, including
 * the four destinations of every reward event. The staked ones are filled in
 * on purpose in some tests: the engine has to leave them alone, and a test
 * that never sets them cannot show that it does.
 */
export interface SplitOptions {
  readonly baker: string;
  readonly cycle: number;
  readonly ownDelegatedBalance: Mutez;
  readonly delegators: readonly SplitDelegator[];
  /** Goes into `blockRewardsDelegated` — the only pool the baker distributes. */
  readonly delegatedRewards: Mutez;
  readonly blockFees?: Mutez;
  /** Already credited by the protocol to the stakers. Never distributable. */
  readonly stakedShared?: Mutez;
  readonly stakedEdge?: Mutez;
  readonly stakedOwn?: Mutez;
  readonly stakers?: readonly { address: string; stakedBalance: Mutez }[];
  readonly futureBlocks?: number;
}

export function makeSplit(options: SplitOptions): RewardSplit {
  const rewards = {} as Record<RewardFieldName, Mutez>;
  for (const field of rewardFieldNames()) rewards[field] = 0n;
  rewards.blockRewardsDelegated = options.delegatedRewards;
  rewards.attestationRewardsStakedShared = options.stakedShared ?? 0n;
  rewards.attestationRewardsStakedEdge = options.stakedEdge ?? 0n;
  rewards.attestationRewardsStakedOwn = options.stakedOwn ?? 0n;

  const external = sumMutez(options.delegators.map((d) => d.delegatedBalance));
  const stakers = options.stakers ?? [];

  return {
    baker: options.baker,
    cycle: options.cycle,
    ownDelegatedBalance: options.ownDelegatedBalance,
    externalDelegatedBalance: external,
    ownStakedBalance: 0n,
    externalStakedBalance: sumMutez(stakers.map((s) => s.stakedBalance)),
    delegatorsCount: options.delegators.length,
    stakersCount: stakers.length,
    bakingPower: 0n,
    totalBakingPower: 0n,
    blockFees: options.blockFees ?? 0n,
    futureBlocks: options.futureBlocks ?? 0,
    rewards: Object.freeze(rewards),
    delegators: options.delegators,
    stakers,
    actualStakers: stakers.map((s) => ({
      address: s.address,
      initialStake: s.stakedBalance,
      finalStake: s.stakedBalance,
      rewards: 0n,
    })),
  };
}

export function delegator(
  address: string,
  delegatedBalance: Mutez,
  emptied = false,
): SplitDelegator {
  return { address, delegatedBalance, emptied };
}
