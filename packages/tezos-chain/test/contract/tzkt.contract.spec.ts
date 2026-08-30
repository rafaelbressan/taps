/**
 * Contract test against the real TzKT API.
 *
 * This is the only check that fails when TzKT removes or renames a field the
 * payout math depends on. Unit tests run against a fixture, and a fixture
 * cannot notice that the API changed — which is exactly how eight removed
 * fields kept being summed to zero for months.
 *
 * Run with the network configured:
 *   TEZOS_NETWORK=mainnet \
 *   TEZOS_RPC_URL=https://rpc.tzbeta.net \
 *   TZKT_API_URL=https://api.tzkt.io \
 *   npm run test:contract
 */
import { HttpError } from '../../src/errors';
import { loadNetworkFromEnv } from '../../src/network';
import {
  ProtocolConstantsProvider,
  REMOVED_CONSTANT_FIELDS,
} from '../../src/rpc/protocol-constants';
import { HttpRpcSource } from '../../src/rpc/rpc-source';
import { computePayout, feeRate } from '../../src/rewards/payout';
import { TzKTHttp } from '../../src/tzkt/http';
import { fetchHead } from '../../src/tzkt/head';
import {
  TZKT_MAX_PAGE_SIZE,
  assertBakingPowerConsistent,
  assertDelegatorListComplete,
  fetchRewardSplit,
  rewardFieldNames,
} from '../../src/tzkt/reward-split';

const network = loadNetworkFromEnv();
const http = new TzKTHttp(network, { concurrency: 2, maxLagBlocks: 5 });
const rpc = new HttpRpcSource(network);
const constantsProvider = new ProtocolConstantsProvider(rpc);

/** A baker with delegators and stakers, used as the reference all along. */
const REFERENCE_BAKER = 'tz1fwnfJNgiDACshK9avfRfFbMaXrs3ghoJa';
/** A baker large enough that one page is not the whole list. */
const LARGE_BAKER = 'tz1aRoaRhSpRYvFdyvgWLL6TGyRoGF51wDjM';

describe(`TzKT contract (${network.name})`, () => {
  jest.setTimeout(180_000);

  let closedCycle: number;

  beforeAll(async () => {
    const head = await fetchHead(http);
    // Distribute cycle N only once N+2 has started: denunciation_period and
    // slashing_delay are 1 each, so a denunciation of cycle N can still cut
    // the amounts during N+1.
    closedCycle = head.cycle - 2;
  });

  it('serves every protocol constant the chain layer reads', async () => {
    const constants = await constantsProvider.get();
    expect(constants.blocksPerCycle).toBeGreaterThan(0);
    expect(constants.minimalBlockDelay).toBeGreaterThan(0);
    expect(constants.consensusCommitteeSize).toBeGreaterThan(0);
    expect(constants.hardGasLimitPerBlock).toBeGreaterThan(0n);
    expect(constants.maxOperationsTimeToLive).toBeGreaterThan(0);
    expect(constants.edgeOfStakingOverDelegation).toBeGreaterThan(0);
    expect(constants.chainId).toMatch(/^Net/);
    expect(constants.protocolHash).toMatch(/^P/);
  });

  it('still does not serve the fields the old client read', async () => {
    const raw = await rpc.getRawConstants();
    for (const removed of REMOVED_CONSTANT_FIELDS) {
      expect(Object.keys(raw)).not.toContain(removed);
    }
  });

  it('serves all twenty reward fields for a closed cycle', async () => {
    const split = await fetchRewardSplit(http, REFERENCE_BAKER, closedCycle);
    for (const field of rewardFieldNames()) {
      // fetchRewardSplit already raises on a missing field; this states the
      // expectation explicitly so a failure reads as a contract break.
      expect(typeof split.rewards[field]).toBe('bigint');
    }
    expect(split.cycle).toBe(closedCycle);
    expect(split.futureBlocks).toBe(0);
  });

  it('closes the delegator-list and baking-power invariants on live data', async () => {
    const [split, constants] = await Promise.all([
      fetchRewardSplit(http, REFERENCE_BAKER, closedCycle),
      constantsProvider.get(),
    ]);
    expect(() => assertDelegatorListComplete(split)).not.toThrow();
    expect(() => assertBakingPowerConsistent(split, constants)).not.toThrow();
  });

  it('pages a baker whose delegator list does not fit in one request', async () => {
    const split = await fetchRewardSplit(http, LARGE_BAKER, closedCycle);
    expect(split.delegatorsCount).toBeGreaterThan(TZKT_MAX_PAGE_SIZE);
    expect(split.delegators).toHaveLength(split.delegatorsCount);
    expect(() => assertDelegatorListComplete(split)).not.toThrow();
  });

  it('reports StakedShared as already credited to the stakers', async () => {
    const split = await fetchRewardSplit(http, REFERENCE_BAKER, closedCycle);
    const plan = computePayout({ split, fee: feeRate(10n, 100n) });

    const actualStakerRewards = split.actualStakers.reduce(
      (sum, staker) => sum + staker.rewards,
      0n,
    );
    // Stakers entering or leaving mid-cycle make this an equality in practice
    // rather than a guaranteed identity; a few mutez of drift is expected,
    // paying the parcel again is not.
    const drift = plan.alreadySettled.stakedShared - actualStakerRewards;
    expect(drift < 0n ? -drift : drift).toBeLessThan(1000n);

    const distributed = plan.entries.reduce((sum, entry) => sum + entry.cycleAmount, 0n);
    expect(plan.ownShare + plan.bakerFee + distributed + plan.remainder).toBe(plan.pool);
  });

  it('still rejects a page larger than its documented ceiling', async () => {
    const error = await http
      .get(`/v1/rewards/split/${REFERENCE_BAKER}/${closedCycle}`, {
        limit: TZKT_MAX_PAGE_SIZE + 1,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
  });

  it('answers an unknown operation hash with an empty body, not a 404', async () => {
    const { body } = await http.get(
      '/v1/operations/opCdNE9wDRzYxKKRYuqxawTtzScJFFauXihZa7aszBHqpuZyFsk/status',
    );
    // Either a known hash (boolean) or unknown (204, undefined). What must
    // never happen is a thrown JSON syntax error.
    expect(body === undefined || typeof body === 'boolean').toBe(true);
  });
});
