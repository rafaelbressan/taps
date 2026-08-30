import { InvariantViolationError, MissingFieldError } from '../../src/errors';
import { parseProtocolConstants } from '../../src/rpc/protocol-constants';
import { TzKTHttp } from '../../src/tzkt/http';
import {
  TZKT_MAX_PAGE_SIZE,
  assertBakingPowerConsistent,
  assertDelegatorListComplete,
  fetchRewardSplit,
  parseRewardSplit,
  rewardFieldNames,
} from '../../src/tzkt/reward-split';
import { FRESH_HEADERS, FakeFetch } from '../helpers/fake-fetch';
import { TEST_NETWORK } from '../helpers/network';
import bakeNug1336 from '../fixtures/rewards-split-bake-nug-1336.json';

const BAKE_NUG = 'tz1fwnfJNgiDACshK9avfRfFbMaXrs3ghoJa';
const RAW = bakeNug1336 as unknown as Record<string, unknown>;

const MAINNET_CONSTANTS = parseProtocolConstants(
  {
    blocks_per_cycle: 14400,
    minimal_block_delay: 6,
    delay_increment_per_round: 3,
    consensus_rights_delay: 2,
    blocks_preservation_cycles: 1,
    consensus_committee_size: 7000,
    consensus_threshold_size: 4667,
    hard_gas_limit_per_operation: 1040000,
    hard_gas_limit_per_block: 1040000,
    hard_storage_limit_per_operation: 60000,
    max_operation_data_length: 32768,
    max_operations_time_to_live: 600,
    cost_per_byte: 250,
    origination_size: 257,
    edge_of_staking_over_delegation: 3,
    minimal_stake: 6000000000,
    denunciation_period: 1,
    slashing_delay: 1,
  },
  'NetXdQprcVkpaWU',
  'PsUshuai9QapM5TGj1JpuVGkdxz5GykdnEvS6Rh8SUVrARvZLCY',
);

describe('reward split parsing', () => {
  it('reads the twenty reward fields the API actually returns', () => {
    const split = parseRewardSplit([RAW], BAKE_NUG, 1336);
    expect(rewardFieldNames()).toHaveLength(20);
    expect(split.rewards.blockRewardsDelegated).toBe(15_919_946n);
    expect(split.rewards.attestationRewardsDelegated).toBe(15_313_332n);
    expect(split.rewards.blockRewardsStakedShared).toBe(99_690_382n);
    expect(split.delegators).toHaveLength(2919);
    expect(split.stakers).toHaveLength(75);
  });

  it('never reads the DEPRECATED endorsement* aliases', () => {
    // They are still in the payload; the OpenAPI marks them DEPRECATED.
    expect(RAW).toHaveProperty('endorsementRewardsDelegated');
    expect(rewardFieldNames().some((field) => field.startsWith('endorsement'))).toBe(false);
  });

  it('raises with the field name when a field is gone, instead of returning 0', () => {
    // Every one of these was summed by the old client with `|| 0`, and every
    // one of them is absent from the current response. The result was
    // totalRewards = 0 for every baker, with no exception raised.
    const removed = [
      'ownBlockRewards',
      'extraBlockRewards',
      'endorsementRewards',
      'ownBlockFees',
      'extraBlockFees',
      'revelationRewards',
      'doubleBakingLostRewards',
      'doubleEndorsingLostRewards',
    ];
    for (const field of removed) {
      expect(RAW).not.toHaveProperty(field);
    }

    const { attestationRewardsDelegated: _gone, ...withoutField } = RAW;
    expect(() => parseRewardSplit([withoutField], BAKE_NUG, 1336)).toThrow(
      MissingFieldError,
    );
    expect(() => parseRewardSplit([withoutField], BAKE_NUG, 1336)).toThrow(
      /missing field "attestationRewardsDelegated"/,
    );
    expect(() => parseRewardSplit([withoutField], BAKE_NUG, 1336)).toThrow(
      /refusing to substitute a default/,
    );
  });

  it('raises when a field is present but null', () => {
    expect(() =>
      parseRewardSplit([{ ...RAW, externalDelegatedBalance: null }], BAKE_NUG, 1336),
    ).toThrow(/missing field "externalDelegatedBalance".*present but null/s);
  });
});

describe('invariants that can fail', () => {
  it('closes on the complete list', () => {
    const split = parseRewardSplit([RAW], BAKE_NUG, 1336);
    expect(() => assertDelegatorListComplete(split)).not.toThrow();
  });

  it('aborts on a truncated delegator list', () => {
    // Exactly the Everstake case: one page of 10 000 out of 60 258. Here the
    // list is cut at 100 — the API's default limit.
    const truncated = {
      ...RAW,
      delegators: (RAW.delegators as unknown[]).slice(0, 100),
    };
    const split = parseRewardSplit([truncated], BAKE_NUG, 1336);

    expect(() => assertDelegatorListComplete(split)).toThrow(InvariantViolationError);
    expect(() => assertDelegatorListComplete(split)).toThrow(/truncated/);
    expect(() => assertDelegatorListComplete(split)).toThrow(
      /listed 100 delegators/,
    );
  });

  it('checks bakingPower against the edge read from the chain', () => {
    const split = parseRewardSplit([RAW], BAKE_NUG, 1336);
    // 235550399083 + 1039802790978 + (931097498 + 497320419308) / 3
    expect(() => assertBakingPowerConsistent(split, MAINNET_CONSTANTS)).not.toThrow();
    expect(split.bakingPower).toBe(1_441_437_028_996n);
  });

  it('aborts when bakingPower does not match the reported balances', () => {
    const tampered = parseRewardSplit(
      [{ ...RAW, ownStakedBalance: 1 }],
      BAKE_NUG,
      1336,
    );
    expect(() => assertBakingPowerConsistent(tampered, MAINNET_CONSTANTS)).toThrow(
      /bakingPower == staked \+ delegated/,
    );
  });
});

describe('pagination', () => {
  /** A baker the size of Everstake in cycle 1336: 60 258 delegators. */
  function everstakeLikePayload() {
    const delegatorsCount = 60_258;
    const delegators = Array.from({ length: delegatorsCount }, (_, index) => ({
      address: `tz1delegator${String(index).padStart(24, '0')}`,
      delegatedBalance: 1_000_000 + index,
      emptied: false,
    }));
    const externalDelegatedBalance = delegators.reduce(
      (sum, d) => sum + d.delegatedBalance,
      0,
    );
    return { delegatorsCount, delegators, externalDelegatedBalance };
  }

  it('reads all 60 258 delegators, seven pages of ten thousand', async () => {
    const { delegatorsCount, delegators, externalDelegatedBalance } =
      everstakeLikePayload();

    const fake = new FakeFetch((url) => {
      const parsed = new URL(url);
      const limit = Number(parsed.searchParams.get('limit'));
      const offset = Number(parsed.searchParams.get('offset'));
      expect(limit).toBeLessThanOrEqual(TZKT_MAX_PAGE_SIZE);
      return {
        status: 200,
        headers: FRESH_HEADERS(),
        body: JSON.stringify({
          ...RAW,
          delegatorsCount,
          externalDelegatedBalance,
          delegators: delegators.slice(offset, offset + limit),
          stakers: [],
          actualStakers: [],
        }),
      };
    });

    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch });
    const split = await fetchRewardSplit(http, 'tz1everstake', 1336);

    expect(fake.requests).toHaveLength(7);
    expect(split.delegators).toHaveLength(60_258);
    expect(() => assertDelegatorListComplete(split)).not.toThrow();
  });

  it('a single page of ten thousand is not enough, and the invariant says so', async () => {
    const { delegatorsCount, delegators, externalDelegatedBalance } =
      everstakeLikePayload();

    const onePage = parseRewardSplit(
      [
        {
          ...RAW,
          delegatorsCount,
          externalDelegatedBalance,
          delegators: delegators.slice(0, TZKT_MAX_PAGE_SIZE),
        },
      ],
      'tz1everstake',
      1336,
    );

    expect(onePage.delegators).toHaveLength(10_000);
    expect(() => assertDelegatorListComplete(onePage)).toThrow(/truncated/);
  });

  it('stops paging once a page comes back short', async () => {
    const fake = new FakeFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return {
        status: 200,
        headers: FRESH_HEADERS(),
        body: JSON.stringify({
          ...RAW,
          delegators: offset === 0 ? (RAW.delegators as unknown[]) : [],
          stakers: offset === 0 ? (RAW.stakers as unknown[]) : [],
          actualStakers: offset === 0 ? (RAW.actualStakers as unknown[]) : [],
        }),
      };
    });
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch });
    const split = await fetchRewardSplit(http, BAKE_NUG, 1336);

    expect(fake.requests).toHaveLength(1);
    expect(split.delegators).toHaveLength(2919);
  });
});
