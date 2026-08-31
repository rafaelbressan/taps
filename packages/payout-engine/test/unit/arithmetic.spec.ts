import { computePayout, feeRate, sumMutez, type Mutez } from '@tezos-suite/chain';
import { buildDelegatorLines } from '../../src/breakdown';
import { makeMinimumPayout } from '../../src/minimum';
import { tz1 } from '../helpers/addresses';
import { delegator, makeSplit } from '../helpers/split';

/**
 * A property test over the arithmetic, on random inputs.
 *
 * It is written against identities that hold independently of how the numbers
 * were produced. The check it replaces — `validateCalculation()` in the
 * current TAPS — defines the baker's share as "total minus payments" and then
 * asserts that share plus payments equals the total, which is true for any
 * value of payments, including every one of them being zero.
 */

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const CASES = 200;

describe('the payout arithmetic, over random inputs', () => {
  it('never invents a mutez and never loses one', () => {
    const random = makeRandom(0x5eed_1336);

    for (let round = 0; round < CASES; round += 1) {
      const count = 1 + Math.floor(random() * 40);
      const delegators = Array.from({ length: count }, (_, index) =>
        delegator(
          tz1(500_000 + round * 100 + index),
          BigInt(1 + Math.floor(random() * 5_000_000_000)),
          random() < 0.1,
        ),
      );
      const split = makeSplit({
        baker: tz1(1),
        cycle: 1336 + round,
        ownDelegatedBalance: BigInt(Math.floor(random() * 5_000_000_000)),
        delegatedRewards: BigInt(Math.floor(random() * 500_000_000)),
        delegators,
      });

      const denominator = 10_000n;
      const fee = feeRate(BigInt(Math.floor(random() * 10_001)), denominator);
      const cut = BigInt(Math.floor(random() * 2_000));
      const carryIn = new Map<string, Mutez>(
        delegators
          .filter(() => random() < 0.3)
          .map((d) => [d.address, BigInt(Math.floor(random() * 5_000))]),
      );

      const plan = computePayout({
        split,
        fee,
        carryIn,
        minimumPayout: makeMinimumPayout({
          feeByAddress: new Map(delegators.map((d) => [d.address, cut])),
          allocationBurn: BigInt(Math.floor(random() * 100_000)),
          bakerFloor: 0n,
        }),
      });
      const lines = buildDelegatorLines(split, plan, fee);
      const where = `round ${round}`;

      // Nothing is created: the pool is exactly the baker's own share, the
      // commission, what the delegators earned, and the rounding leftover.
      const earned = sumMutez(lines.map((l) => l.net));
      expect(plan.ownShare + plan.bakerFee + earned + plan.remainder).toBe(plan.pool);
      expect(plan.remainder).toBeGreaterThanOrEqual(0n);

      // Nothing is lost: whatever is not sent is owed, to the mutez.
      const carriedInTotal = sumMutez(lines.map((l) => l.carriedIn));
      const sent = sumMutez(lines.map((l) => l.amount));
      const owed = sumMutez(lines.map((l) => l.carriedOut));
      expect(sent + owed).toBe(earned + carriedInTotal);

      // Nothing goes out that did not come in.
      expect(sent).toBeLessThanOrEqual(earned + carriedInTotal);
      expect(sent).toBe(plan.totalToSend);

      for (const line of lines) {
        expect(line.gross).toBe(line.commission + line.net);
        expect(line.amount + line.carriedOut).toBe(line.payable);
        expect(line.net).toBeGreaterThanOrEqual(0n);
        expect(line.commission).toBeGreaterThanOrEqual(0n);
        expect(line.amount).toBeGreaterThanOrEqual(0n);
        expect(line.carriedOut).toBeGreaterThanOrEqual(0n);
        // A paid line cleared the cut; an unpaid one did not.
        expect(line.paid).toBe(line.payable > 0n && line.payable > line.minimum);
        expect(`${where} ${line.address}`).toBeDefined();
      }

      // Per-line commission is `gross - net`, both floor divisions, so it is
      // exact for each delegator but its SUM can miss the pool-level figure by
      // up to one mutez per delegator. The authoritative amount the baker
      // retains stays `bakerFee` plus `remainder`; the per-line column is what
      // that delegator lost to commission, which is what a statement answers.
      const commission = sumMutez(lines.map((l) => l.commission));
      expect(commission).toBeGreaterThanOrEqual(0n);
      const drift = commission > plan.bakerFee ? commission - plan.bakerFee : plan.bakerFee - commission;
      expect(drift).toBeLessThanOrEqual(BigInt(lines.length));
      expect(sumMutez(lines.map((l) => l.gross))).toBeLessThanOrEqual(
        plan.pool - plan.ownShare,
      );
    }
  });

  it('gives the whole pool to the baker at a 100% commission, and none of it at 0%', () => {
    const split = makeSplit({
      baker: tz1(1),
      cycle: 1336,
      ownDelegatedBalance: 0n,
      delegatedRewards: 1_000_000n,
      delegators: [delegator(tz1(701), 1_000_000_000n), delegator(tz1(702), 3_000_000_000n)],
    });

    const all = computePayout({ split, fee: feeRate(1n, 1n) });
    expect(all.distributable).toBe(0n);
    expect(all.bakerFee).toBe(1_000_000n);
    expect(all.totalToSend).toBe(0n);

    const none = computePayout({ split, fee: feeRate(0n, 1n) });
    expect(none.bakerFee).toBe(0n);
    expect(none.distributable).toBe(1_000_000n);
    expect(sumMutez(none.entries.map((e) => e.cycleAmount)) + none.remainder).toBe(1_000_000n);
  });
});
