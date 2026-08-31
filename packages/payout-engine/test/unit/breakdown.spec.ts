import { InvariantViolationError, computePayout, feeRate } from '@tezos-suite/chain';
import { assertLinesClose, buildDelegatorLines, type DelegatorLine } from '../../src/breakdown';
import { tz1 } from '../helpers/addresses';
import { delegator, makeSplit } from '../helpers/split';

const split = makeSplit({
  baker: tz1(1),
  cycle: 1336,
  ownDelegatedBalance: 1_000_000_000n,
  delegatedRewards: 28_057_420n,
  delegators: [delegator(tz1(801), 4_000_000_000n), delegator(tz1(802), 6_000_000_000n)],
});
const fee = feeRate(500n, 10_000n);
const plan = computePayout({ split, fee });

describe('the per-delegator decomposition', () => {
  it('splits every share into commission and net, exactly', () => {
    const lines = buildDelegatorLines(split, plan, fee);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.gross).toBe(line.commission + line.net);
      expect(line.net).toBe(
        plan.entries.find((e) => e.address === line.address)!.cycleAmount,
      );
    }
  });

  it('marks the reason a line was not paid', () => {
    const withCut = computePayout({
      split,
      fee,
      minimumPayout: () => 100_000_000n,
    });
    const lines = buildDelegatorLines(split, withCut, fee);
    expect(lines.map((l) => l.reason)).toEqual(['below-cut', 'below-cut']);
    expect(lines.every((l) => l.withheld === l.payable)).toBe(true);
    expect(lines.every((l) => l.amount === 0n)).toBe(true);
  });
});

describe('the closing check can fail', () => {
  const lines = buildDelegatorLines(split, plan, fee);

  const tamper = (patch: Partial<DelegatorLine>): DelegatorLine[] => [
    { ...lines[0]!, ...patch },
    lines[1]!,
  ];

  it('catches a commission that does not add up', () => {
    expect(() => assertLinesClose(tamper({ commission: 0n }), plan)).toThrow(
      InvariantViolationError,
    );
  });

  it('catches money appearing between payable and amount', () => {
    expect(() => assertLinesClose(tamper({ amount: lines[0]!.amount + 1n }), plan)).toThrow(
      InvariantViolationError,
    );
  });

  it('catches a withheld balance recorded as paid', () => {
    expect(() =>
      assertLinesClose(tamper({ paid: false, withheld: 0n, carriedOut: 0n }), plan),
    ).toThrow(InvariantViolationError);
  });

  it('catches a paid delegator who never cleared the cut', () => {
    expect(() =>
      assertLinesClose(tamper({ minimum: lines[0]!.payable + 1n }), plan),
    ).toThrow(InvariantViolationError);
  });

  it('catches a negative amount', () => {
    expect(() =>
      assertLinesClose(tamper({ amount: -1n, carriedOut: lines[0]!.payable + 1n }), plan),
    ).toThrow(InvariantViolationError);
  });
});
