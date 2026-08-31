import { MissingEstimateError } from '../../src/errors';
import { makeMinimumPayout } from '../../src/minimum';
import { tz1 } from '../helpers/addresses';

const alice = tz1(21);
const bob = tz1(22);

describe('the minimum payment is the estimated fee, not a constant', () => {
  it('is the fee this run estimated for this very transfer', () => {
    const cheap = makeMinimumPayout({
      feeByAddress: new Map([[alice, 477n]]),
      allocationBurn: 64_250n,
      bakerFloor: 0n,
    });
    const busy = makeMinimumPayout({
      feeByAddress: new Map([[alice, 1_910n]]),
      allocationBurn: 64_250n,
      bakerFloor: 0n,
    });
    const context = { address: alice, emptied: false, payable: 1_000n };
    expect(cheap(context)).toBe(477n);
    // Same delegator, same balance, a busier network: the cut moves. A written
    // constant could not do this, which is the whole argument.
    expect(busy(context)).toBe(1_910n);
  });

  it('adds the allocation burn when the destination has to be created', () => {
    const minimum = makeMinimumPayout({
      feeByAddress: new Map([[alice, 500n]]),
      allocationBurn: 64_250n,
      bakerFloor: 0n,
    });
    expect(minimum({ address: alice, emptied: false, payable: 1n })).toBe(500n);
    expect(minimum({ address: alice, emptied: true, payable: 1n })).toBe(64_750n);
  });

  it("takes the baker's floor when it is higher, never when it is lower", () => {
    const higher = makeMinimumPayout({
      feeByAddress: new Map([[alice, 500n]]),
      allocationBurn: 0n,
      bakerFloor: 1_000_000n,
    });
    expect(higher({ address: alice, emptied: false, payable: 1n })).toBe(1_000_000n);

    const lower = makeMinimumPayout({
      feeByAddress: new Map([[alice, 500n]]),
      allocationBurn: 0n,
      bakerFloor: 1n,
    });
    // A floor below the estimated fee would pay out less than it costs to pay.
    expect(lower({ address: alice, emptied: false, payable: 1n })).toBe(500n);
  });

  it('is nothing for a delegator with nothing owed', () => {
    const minimum = makeMinimumPayout({
      feeByAddress: new Map(),
      allocationBurn: 0n,
      bakerFloor: 1_000_000n,
    });
    expect(minimum({ address: bob, emptied: false, payable: 0n })).toBe(0n);
  });

  it('raises for an address that is owed money and was never priced', () => {
    const minimum = makeMinimumPayout({
      feeByAddress: new Map([[alice, 500n]]),
      allocationBurn: 0n,
      bakerFloor: 0n,
    });
    expect(() => minimum({ address: bob, emptied: false, payable: 1n })).toThrow(
      MissingEstimateError,
    );
  });
});
