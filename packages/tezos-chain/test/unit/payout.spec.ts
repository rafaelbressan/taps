import { InvariantViolationError } from '../../src/errors';
import { carryOutOf, computePayout, feeRate } from '../../src/rewards/payout';
import { REWARD_EVENTS, parseRewardSplit } from '../../src/tzkt/reward-split';
import bakeNug1336 from '../fixtures/rewards-split-bake-nug-1336.json';

const BAKE_NUG = 'tz1fwnfJNgiDACshK9avfRfFbMaXrs3ghoJa';
const RAW = bakeNug1336 as unknown as Record<string, unknown>;
const SPLIT = parseRewardSplit([RAW], BAKE_NUG, 1336);
const TEN_PERCENT = feeRate(10n, 100n);

describe('payout, Bake Nug cycle 1336, 10% fee', () => {
  const plan = computePayout({ split: SPLIT, fee: TEN_PERCENT });

  it('distributes only the liquid pool', () => {
    expect(plan.pool).toBe(31_233_278n);
    expect(plan.blockFeesIncluded).toBe(false);
  });

  it('reproduces the worked example, mutez by mutez', () => {
    expect(plan.ownShare).toBe(58_366n);
    expect(plan.bakerFee).toBe(3_117_491n);
    expect(plan.distributable).toBe(28_057_421n);

    const distributed = plan.entries.reduce((sum, entry) => sum + entry.cycleAmount, 0n);
    expect(distributed).toBe(28_056_046n);
    expect(plan.remainder).toBe(1_375n);

    // 58 366 + 3 117 491 + 28 056 046 + 1 375 = 31 233 278
    expect(plan.ownShare + plan.bakerFee + distributed + plan.remainder).toBe(plan.pool);
  });

  it('pays the three largest delegators the amounts measured on chain', () => {
    const byAddress = new Map(plan.entries.map((entry) => [entry.address, entry]));
    expect(byAddress.get('tz1Ysx7W3sNGBijnkpjCvaaJSdKqSAAAiNz2')?.cycleAmount).toBe(
      2_461_373n,
    );
    expect(byAddress.get('tz1Pp56sn9r2jNwN9YwwvTYWHmrpfqeHUFgj')?.cycleAmount).toBe(
      1_509_539n,
    );
    expect(byAddress.get('tz1a4XMNsQgtw5i5PJ2ifQ9wWWJ6cbdEPLsx')?.cycleAmount).toBe(
      1_467_075n,
    );
  });

  it('leaves every value a bigint', () => {
    for (const value of [plan.pool, plan.ownShare, plan.bakerFee, plan.remainder]) {
      expect(typeof value).toBe('bigint');
    }
    for (const entry of plan.entries.slice(0, 50)) {
      expect(typeof entry.cycleAmount).toBe('bigint');
      expect(typeof entry.delegatedBalance).toBe('bigint');
    }
  });
});

describe('the parts the protocol already settled', () => {
  const plan = computePayout({ split: SPLIT, fee: TEN_PERCENT });

  it('never lets StakedShared into the payable pool', () => {
    // Σ(*StakedShared) equals Σ(actualStakers[].rewards) to the mutez: the
    // protocol already credited it. Paying it again pays twice.
    const stakedShared = REWARD_EVENTS.reduce(
      (sum, event) => sum + SPLIT.rewards[`${event}StakedShared`],
      0n,
    );
    const actualStakerRewards = SPLIT.actualStakers.reduce(
      (sum, staker) => sum + staker.rewards,
      0n,
    );
    expect(stakedShared).toBe(195_581_863n);
    expect(actualStakerRewards).toBe(stakedShared);

    expect(plan.alreadySettled.stakedShared).toBe(stakedShared);
    expect(plan.pool).toBe(31_233_278n);

    // If StakedShared had leaked into the pool it would be 7x larger.
    expect(plan.pool).toBeLessThan(stakedShared);
    const distributed = plan.entries.reduce((sum, e) => sum + e.cycleAmount, 0n);
    expect(distributed + plan.bakerFee + plan.ownShare + plan.remainder).toBe(plan.pool);
  });

  it('keeps StakedOwn and StakedEdge out too', () => {
    expect(plan.alreadySettled.stakedOwn).toBe(44_258_037n);
    expect(plan.alreadySettled.stakedEdge).toBe(0n);
    const wouldBeWrong =
      plan.pool +
      plan.alreadySettled.stakedOwn +
      plan.alreadySettled.stakedEdge +
      plan.alreadySettled.stakedShared;
    expect(plan.pool).not.toBe(wouldBeWrong);
  });

  it('adds blockFees only when the baker policy says so', () => {
    const withFees = computePayout({
      split: SPLIT,
      fee: TEN_PERCENT,
      includeBlockFees: true,
    });
    expect(withFees.pool).toBe(31_233_278n + 357_034n);
  });
});

describe('minimum payout and carry-over', () => {
  it('defers whoever does not clear the fee estimated for their own transfer', () => {
    // Not a constant: the fee comes from estimate.batch() at distribution
    // time. 477 mutez is only the median measured on 2026-08-30.
    const estimatedFee = 477n;
    const allocationBurn = 64_250n;
    const plan = computePayout({
      split: SPLIT,
      fee: feeRate(10n, 100n),
      minimumPayout: ({ emptied }) => (emptied ? estimatedFee + allocationBurn : estimatedFee),
    });

    expect(plan.toPay).toHaveLength(1069);
    expect(plan.toPay.every((entry) => entry.payable > estimatedFee)).toBe(true);
    expect(plan.deferred.every((entry) => entry.payable <= estimatedFee)).toBe(true);

    // The deferred balance is debt, not a discard: it must equal what was not
    // sent, and it must reappear next cycle.
    const carry = carryOutOf(plan);
    const deferredTotal = [...carry.values()].reduce((sum, value) => sum + value, 0n);
    const distributed = plan.entries.reduce((sum, e) => sum + e.cycleAmount, 0n);
    expect(plan.totalToSend + deferredTotal).toBe(distributed);
    expect(deferredTotal).toBe(136_178n);

    // The rounding remainder stays with the baker (§3.4), so it is not part
    // of what accumulates: nobody is owed it.
    expect(plan.remainder).toBe(1_375n);
  });

  it('reproduces every row of the survey table in §3.6', () => {
    // Each cut is a policy a baker could pick. The table is a regression test
    // now, so a change in the arithmetic shows up against the document.
    const rows = [
      { cut: 0n, paid: 2645, accumulated: 0n },
      { cut: 477n, paid: 1069, accumulated: 136_178n },
      { cut: 4_770n, paid: 407, accumulated: 1_294_375n },
      { cut: 100_000n, paid: 46, accumulated: 9_616_921n },
    ];

    for (const row of rows) {
      const plan = computePayout({
        split: SPLIT,
        fee: feeRate(10n, 100n),
        minimumPayout: () => row.cut,
      });
      expect({ cut: row.cut, paid: plan.toPay.length }).toEqual({
        cut: row.cut,
        paid: row.paid,
      });
      const accumulated = [...carryOutOf(plan).values()].reduce((sum, v) => sum + v, 0n);
      expect({ cut: row.cut, accumulated }).toEqual({
        cut: row.cut,
        accumulated: row.accumulated,
      });
    }
  });

  it('pays a delegator whose carried balance finally clears the minimum', () => {
    const small = SPLIT.delegators
      .filter((d) => d.delegatedBalance > 0n)
      .slice(-1)
      .map((d) => d.address);
    const address = small[0]!;

    const withoutCarry = computePayout({
      split: SPLIT,
      fee: feeRate(10n, 100n),
      minimumPayout: () => 477n,
    });
    const before = withoutCarry.entries.find((e) => e.address === address)!;
    expect(before.paid).toBe(false);

    const withCarry = computePayout({
      split: SPLIT,
      fee: feeRate(10n, 100n),
      minimumPayout: () => 477n,
      carryIn: new Map([[address, 10_000n]]),
    });
    const after = withCarry.entries.find((e) => e.address === address)!;
    expect(after.carriedIn).toBe(10_000n);
    expect(after.payable).toBe(before.cycleAmount + 10_000n);
    expect(after.paid).toBe(true);
  });
});

describe('guards', () => {
  it('refuses to compute on a truncated delegator list', () => {
    const truncated = parseRewardSplit(
      [{ ...RAW, delegators: (RAW.delegators as unknown[]).slice(0, 500) }],
      BAKE_NUG,
      1336,
    );
    expect(() => computePayout({ split: truncated, fee: TEN_PERCENT })).toThrow(
      InvariantViolationError,
    );
  });

  it('rejects a fee that is not a sane integer ratio', () => {
    expect(() => feeRate(10n, 0n)).toThrow(/denominator/);
    expect(() => feeRate(101n, 100n)).toThrow(/fee numerator/);
    expect(() => feeRate(-1n, 100n)).toThrow(/fee numerator/);
  });

  it('computes a 7.95% fee exactly, where a float would drift', () => {
    const plan = computePayout({ split: SPLIT, fee: feeRate(795n, 10_000n) });
    const externalGross = plan.pool - plan.ownShare;
    expect(plan.bakerFee).toBe((externalGross * 795n) / 10_000n);
    expect(plan.ownShare + plan.bakerFee + plan.distributable).toBe(plan.pool);
  });

  it('refuses a delegator address that fails the checksum', () => {
    const tampered = parseRewardSplit(
      [
        {
          ...RAW,
          delegators: [
            { address: 'tz1Ysx7W3sNGBijnkpjCvaaJSdKqSAAAiNz3', delegatedBalance: 497320419308, emptied: false },
          ],
          delegatorsCount: 1,
        },
      ],
      BAKE_NUG,
      1336,
    );
    expect(() => computePayout({ split: tampered, fee: TEN_PERCENT })).toThrow(/checksum/);
  });
});
