import { InvariantViolationError } from '@tezos-suite/chain';
import { DuplicateDistributionError, DuplicateOperationError } from '../../src/errors';
import { InMemoryPayoutStore } from '../../src/store/memory';
import type { NewDistribution } from '../../src/store/types';
import { operationHash, tz1 } from '../helpers/addresses';

const BAKER = tz1(1);
const ALICE = tz1(31);
const BOB = tz1(32);

function newDistribution(cycle = 1336): NewDistribution {
  return {
    distribution: {
      bakerId: BAKER,
      cycle,
      network: 'testnet',
      protocolHash: 'PsTest',
      pool: 1_000_000n,
      ownShare: 100_000n,
      bakerFee: 45_000n,
      distributable: 855_000n,
      remainder: 0n,
      totalToSend: 855_000n,
      feeNumerator: 5n,
      feeDenominator: 100n,
      blockFeesIncluded: false,
      delegatorCount: 2,
    },
    lines: [ALICE, BOB].map((address) => ({
      bakerId: BAKER,
      cycle,
      address,
      delegatedBalanceMutez: 1_000_000n,
      grossMutez: 450_000n,
      commissionMutez: 22_500n,
      netMutez: 427_500n,
      carriedInMutez: 0n,
      payableMutez: 427_500n,
      minimumMutez: 500n,
      withheldMutez: 0n,
      amountMutez: 427_500n,
      carriedOutMutez: 0n,
      emptied: false,
    })),
    batches: [
      {
        bakerId: BAKER,
        cycle,
        index: 0,
        transfers: [ALICE, BOB].map((address) => ({
          address,
          amountMutez: 427_500n,
          feeMutez: 500n,
          gasLimit: 2_169n,
          storageLimit: 0n,
          burnMutez: 0n,
        })),
        totalAmount: 855_000n,
        totalFees: 1_000n,
        totalBurn: 0n,
        totalGas: 4_338n,
        totalStorage: 0n,
      },
    ],
  };
}

describe('the store is what makes a duplicate payment impossible', () => {
  it('refuses a second distribution of the same cycle', async () => {
    const store = new InMemoryPayoutStore();
    await store.createDistribution(newDistribution());
    // The current TAPS key is (bakerId, cycle, date, result), which lets the
    // same cycle be written again tomorrow, or with another result.
    await expect(store.createDistribution(newDistribution())).rejects.toBeInstanceOf(
      DuplicateDistributionError,
    );
  });

  it('accepts a different cycle for the same baker', async () => {
    const store = new InMemoryPayoutStore();
    await store.createDistribution(newDistribution(1336));
    await expect(store.createDistribution(newDistribution(1337))).resolves.toBeDefined();
  });

  it('refuses the same operation hash on two batches', async () => {
    const store = new InMemoryPayoutStore();
    await store.createDistribution(newDistribution(1336));
    await store.createDistribution(newDistribution(1337));
    const hash = operationHash(5);
    const intent = {
      bakerId: BAKER,
      index: 0,
      opHash: hash,
      counter: '10',
      branch: 'B',
      branchLevel: 100,
      at: new Date(),
    };
    await store.recordInjectionIntent({ ...intent, cycle: 1336 });
    await expect(
      store.recordInjectionIntent({ ...intent, cycle: 1337 }),
    ).rejects.toBeInstanceOf(DuplicateOperationError);
  });

  it('never replaces the hash of a previous attempt', async () => {
    const store = new InMemoryPayoutStore();
    await store.createDistribution(newDistribution());
    const base = {
      bakerId: BAKER,
      cycle: 1336,
      index: 0,
      counter: '10',
      branch: 'B',
      branchLevel: 100,
      at: new Date(),
    };
    await store.recordInjectionIntent({ ...base, opHash: operationHash(6) });
    // `clearPreviousAttempt()` in the current TAPS does exactly this, and it
    // destroys the only evidence that the money may already have left.
    await expect(
      store.recordInjectionIntent({ ...base, opHash: operationHash(7) }),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    const snapshot = await store.getDistribution(BAKER, 1336);
    expect(snapshot?.batches[0]?.opHash).toBe(operationHash(6));
  });

  it('writes a settlement whole or not at all', async () => {
    const store = new InMemoryPayoutStore();
    await store.createDistribution(newDistribution());

    await expect(
      store.settleDistribution({
        bakerId: BAKER,
        cycle: 1336,
        status: 'settled',
        lines: [
          { address: ALICE, result: 'applied', batchIndex: 0, opHash: operationHash(8) },
          { address: tz1(999), result: 'applied', batchIndex: 0, opHash: operationHash(8) },
        ],
        carryOver: new Map(),
        at: new Date(),
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    const snapshot = await store.getDistribution(BAKER, 1336);
    expect(snapshot?.distribution.status).toBe('planned');
    expect(snapshot?.lines.every((line) => line.result === 'planned')).toBe(true);
  });

  it('keeps carry-over as a balance, and clears it when it is paid', async () => {
    const store = new InMemoryPayoutStore();
    await store.createDistribution(newDistribution());
    await store.settleDistribution({
      bakerId: BAKER,
      cycle: 1336,
      status: 'settled',
      lines: [
        { address: ALICE, result: 'applied', batchIndex: 0, opHash: operationHash(9) },
        { address: BOB, result: 'deferred', batchIndex: null, opHash: null },
      ],
      carryOver: new Map([
        [ALICE, 0n],
        [BOB, 123n],
      ]),
      at: new Date(),
    });
    expect(await store.loadCarryOver(BAKER)).toEqual(new Map([[BOB, 123n]]));
  });
});
