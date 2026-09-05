import { ConfigurationError } from '@tezos-suite/chain';
import { InvalidPayoutFactorError, MissingEstimateError } from '../../src/errors';
import {
  applyPayoutFactor,
  formatPayoutFactor,
  loadPayoutFactor,
  makeMinimumPayout,
  parsePayoutFactor,
  payoutFactor,
} from '../../src/minimum';
import { tz1 } from '../helpers/addresses';

const alice = tz1(21);
const bob = tz1(22);

const K1 = payoutFactor(1n, 1n);

describe('the cut is K times the estimated cost, not a constant', () => {
  it('is the fee this run estimated for this very transfer', () => {
    const cheap = makeMinimumPayout({
      feeByAddress: new Map([[alice, 477n]]),
      allocationBurn: 64_250n,
      factor: K1,
    });
    const busy = makeMinimumPayout({
      feeByAddress: new Map([[alice, 1_910n]]),
      allocationBurn: 64_250n,
      factor: K1,
    });
    const context = { address: alice, emptied: false, payable: 1_000n };
    expect(cheap(context)).toBe(477n);
    // Same delegator, same balance, a busier network: the cut moves. A written
    // constant could not do this, which is the whole argument.
    expect(busy(context)).toBe(1_910n);
  });

  it('scales with K, and K may have a fractional part', () => {
    const context = { address: alice, emptied: false, payable: 1_000_000n };
    const cost = new Map([[alice, 1_800n]]);

    const at1 = makeMinimumPayout({ feeByAddress: cost, allocationBurn: 0n, factor: K1 });
    const at3 = makeMinimumPayout({
      feeByAddress: cost,
      allocationBurn: 0n,
      factor: payoutFactor(3n, 1n),
    });
    // The worked example of RN-24: K = 3 against a 1 800 mutez transfer.
    expect(at1(context)).toBe(1_800n);
    expect(at3(context)).toBe(5_400n);

    const at1point5 = makeMinimumPayout({
      feeByAddress: new Map([[alice, 477n]]),
      allocationBurn: 0n,
      factor: parsePayoutFactor('1.5'),
    });
    // Rounded UP: 715.5 admits 716, never 715.
    expect(at1point5(context)).toBe(716n);
  });

  it('adds the allocation burn when the destination has to be created', () => {
    const minimum = makeMinimumPayout({
      feeByAddress: new Map([[alice, 500n]]),
      allocationBurn: 64_250n,
      factor: K1,
    });
    expect(minimum({ address: alice, emptied: false, payable: 1n })).toBe(500n);
    expect(minimum({ address: alice, emptied: true, payable: 1n })).toBe(64_750n);
  });

  it('applies K to the allocation burn too', () => {
    const minimum = makeMinimumPayout({
      feeByAddress: new Map([[alice, 500n]]),
      allocationBurn: 64_250n,
      factor: payoutFactor(2n, 1n),
    });
    // Creating the account is part of what paying them costs, so K covers it.
    expect(minimum({ address: alice, emptied: true, payable: 1n })).toBe(129_500n);
  });

  it('is nothing for a delegator with nothing owed', () => {
    const minimum = makeMinimumPayout({
      feeByAddress: new Map(),
      allocationBurn: 0n,
      factor: payoutFactor(10n, 1n),
    });
    expect(minimum({ address: bob, emptied: false, payable: 0n })).toBe(0n);
  });

  it('raises for an address that is owed money and was never priced', () => {
    const minimum = makeMinimumPayout({
      feeByAddress: new Map([[alice, 500n]]),
      allocationBurn: 0n,
      factor: K1,
    });
    expect(() => minimum({ address: bob, emptied: false, payable: 1n })).toThrow(
      MissingEstimateError,
    );
  });
});

describe('K itself', () => {
  it('rounds the cut up, never down', () => {
    // 3 x 1/3 has to be 1, and 1 x 1/3 has to be 1 as well: a cut of zero
    // would let through a payment the transfer cannot even carry.
    expect(applyPayoutFactor(1n, parsePayoutFactor('1.5'))).toBe(2n);
    expect(applyPayoutFactor(3n, parsePayoutFactor('1.5'))).toBe(5n);
    expect(applyPayoutFactor(1_800n, payoutFactor(3n, 1n))).toBe(5_400n);
  });

  it('refuses K below 1, because it would pay less than the transfer costs', () => {
    expect(() => payoutFactor(1n, 2n)).toThrow(InvalidPayoutFactorError);
    expect(() => parsePayoutFactor('0.5')).toThrow(InvalidPayoutFactorError);
    expect(() => parsePayoutFactor('0')).toThrow(InvalidPayoutFactorError);
  });

  it('refuses a ratio that is not one', () => {
    expect(() => payoutFactor(3n, 0n)).toThrow(InvalidPayoutFactorError);
  });

  it('parses a decimal exactly, never through a float', () => {
    expect(parsePayoutFactor('3')).toEqual({ numerator: 3n, denominator: 1n });
    expect(parsePayoutFactor('1.5')).toEqual({ numerator: 15n, denominator: 10n });
    expect(parsePayoutFactor('2.25')).toEqual({ numerator: 225n, denominator: 100n });
    expect(() => parsePayoutFactor('1,5')).toThrow(ConfigurationError);
    expect(() => parsePayoutFactor('1e3')).toThrow(ConfigurationError);
  });

  it('reads back the way a baker wrote it', () => {
    expect(formatPayoutFactor(payoutFactor(3n, 1n))).toBe('3');
    expect(formatPayoutFactor(parsePayoutFactor('1.5'))).toBe('15/10');
  });

  it('has no default: an unset K stops the process', () => {
    expect(() => loadPayoutFactor({})).toThrow(ConfigurationError);
    expect(() => loadPayoutFactor({ TAPS_PAYOUT_MIN_FACTOR: '  ' })).toThrow(
      ConfigurationError,
    );
    expect(loadPayoutFactor({ TAPS_PAYOUT_MIN_FACTOR: '3' })).toEqual({
      numerator: 3n,
      denominator: 1n,
    });
  });
});
