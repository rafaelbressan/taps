import {
  MutezParseError,
  formatMutezAsTez,
  mutezToTaquitoAmount,
  sumMutez,
  tezToMutez,
} from '../../src/mutez';

describe('mutez arithmetic', () => {
  it('converts the value that Math.floor(tez * 1e6) gets wrong', () => {
    // The measured failure: 2309 of 200 000 values lose one mutez, always
    // downward. 0.00397 is the canonical one.
    expect(Math.floor(0.00397 * 1_000_000)).toBe(3969);
    expect(tezToMutez('0.00397')).toBe(3970n);
    expect(tezToMutez('0.00399')).toBe(3990n);
    expect(tezToMutez('0.00785')).toBe(7850n);
  });

  it('parses whole and fractional amounts exactly', () => {
    expect(tezToMutez('0')).toBe(0n);
    expect(tezToMutez('1')).toBe(1_000_000n);
    expect(tezToMutez('0.29')).toBe(290_000n);
    expect(tezToMutez('2.461373')).toBe(2_461_373n);
    expect(tezToMutez('-0.5')).toBe(-500_000n);
  });

  it('refuses to round a value with more precision than mutez has', () => {
    expect(() => tezToMutez('0.0000001')).toThrow(MutezParseError);
    expect(() => tezToMutez('0.0000001')).toThrow(/7 decimals/);
  });

  it('rejects anything that is not a decimal string', () => {
    for (const bad of ['', 'abc', '1,5', '1e6', ' 1.0.0']) {
      expect(() => tezToMutez(bad)).toThrow(MutezParseError);
    }
  });

  it('formats for display only, and round-trips', () => {
    expect(formatMutezAsTez(2_461_373n)).toBe('2.461373');
    expect(formatMutezAsTez(3970n)).toBe('0.003970');
    expect(formatMutezAsTez(-500_000n)).toBe('-0.500000');
    expect(tezToMutez(formatMutezAsTez(31_233_278n))).toBe(31_233_278n);
  });

  it('sums without leaving bigint', () => {
    expect(sumMutez([1n, 2n, 3n])).toBe(6n);
    expect(sumMutez([])).toBe(0n);
  });

  it('refuses to hand Taquito a value it cannot represent', () => {
    expect(mutezToTaquitoAmount(31_233_278n)).toBe(31_233_278);
    expect(() => mutezToTaquitoAmount(-1n)).toThrow(MutezParseError);
    expect(() => mutezToTaquitoAmount(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      /MAX_SAFE_INTEGER/,
    );
  });
});
