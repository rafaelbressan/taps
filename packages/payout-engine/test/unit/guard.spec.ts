import { ConfigurationError, type EstimatedTransfer } from '@tezos-suite/chain';
import {
  CycleCapExceededError,
  DestinationNotAllowedError,
  StorageAllocationError,
} from '../../src/errors';
import {
  allocationCost,
  assertCycleCap,
  assertDestinationsAllowed,
  assertStorageAllocationCovered,
  loadPayoutLimits,
} from '../../src/guard';
import { testConstants } from '../helpers/constants';
import { tz1 } from '../helpers/addresses';

const transfer = (address: string, storageLimit: bigint): EstimatedTransfer => ({
  address,
  amount: 1_000n,
  gasLimit: 2_169n,
  storageLimit,
  feeMutez: 500n,
  burnMutez: 0n,
});

describe('destination allowlist', () => {
  const delegator = tz1(10);
  const attacker = tz1(99);

  it('lets a delegator of the cycle through', () => {
    expect(() =>
      assertDestinationsAllowed(
        [transfer(delegator, 0n)],
        new Set([delegator]),
        tz1(1),
        1336,
      ),
    ).not.toThrow();
  });

  it('refuses an address the split never listed', () => {
    // This is the signer-misuse case: the signer would sign it happily, so
    // the refusal has to happen before the signature is asked for.
    expect(() =>
      assertDestinationsAllowed(
        [transfer(delegator, 0n), transfer(attacker, 0n)],
        new Set([delegator]),
        tz1(1),
        1336,
      ),
    ).toThrow(DestinationNotAllowedError);
  });
});

describe('storage for the allocation burn', () => {
  const constants = testConstants();
  const fresh = tz1(11);

  it('accepts storage that covers origination_size', () => {
    expect(() =>
      assertStorageAllocationCovered(
        [transfer(fresh, BigInt(constants.originationSize))],
        new Set([fresh]),
        constants,
      ),
    ).not.toThrow();
  });

  it('refuses the fixed zero that takes the whole batch down', () => {
    expect(() =>
      assertStorageAllocationCovered([transfer(fresh, 0n)], new Set([fresh]), constants),
    ).toThrow(StorageAllocationError);
  });

  it('derives the burn from the chain rather than naming it', () => {
    expect(allocationCost(constants)).toBe(
      BigInt(constants.originationSize) * constants.costPerByte,
    );
    const cheaper = testConstants({ cost_per_byte: 125 });
    expect(allocationCost(cheaper)).toBe(allocationCost(constants) / 2n);
  });
});

describe('per-cycle ceiling', () => {
  it('refuses to boot without one', () => {
    expect(() => loadPayoutLimits({})).toThrow(ConfigurationError);
    expect(() => loadPayoutLimits({ TAPS_PAYOUT_CYCLE_CAP_MUTEZ: '  ' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadPayoutLimits({ TAPS_PAYOUT_CYCLE_CAP_MUTEZ: '1.5' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadPayoutLimits({ TAPS_PAYOUT_CYCLE_CAP_MUTEZ: '0' })).toThrow(
      ConfigurationError,
    );
  });

  it('reads the ceiling in mutez', () => {
    expect(loadPayoutLimits({ TAPS_PAYOUT_CYCLE_CAP_MUTEZ: '28057420' })).toEqual({
      cycleCapMutez: 28_057_420n,
    });
  });

  it('stops a run that would move more than the ceiling', () => {
    const limits = { cycleCapMutez: 1_000n };
    expect(() => assertCycleCap(1_000n, limits, 1336)).not.toThrow();
    expect(() => assertCycleCap(1_001n, limits, 1336)).toThrow(CycleCapExceededError);
  });
});
