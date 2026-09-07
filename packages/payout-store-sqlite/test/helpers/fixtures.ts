import type {
  NewDebtSettlement,
  NewDistribution,
  PayoutStore,
} from '@tezos-suite/payout';

/** Addresses that decode, so the store is exercised with real base58. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function tz1(seed: number): string {
  let value = seed;
  let tail = '';
  while (tail.length < 33) {
    tail += ALPHABET[value % ALPHABET.length];
    value = value * 31 + 7;
  }
  return `tz1${tail}`;
}

export function operationHash(seed: number): string {
  let value = seed;
  let tail = '';
  while (tail.length < 49) {
    tail += ALPHABET[value % ALPHABET.length];
    value = value * 17 + 3;
  }
  return `o${tail}`;
}

export const BAKER = tz1(1);
export const ALICE = tz1(31);
export const BOB = tz1(32);

export function newDistribution(cycle = 1336): NewDistribution {
  return {
    distribution: {
      bakerId: BAKER,
      cycle,
      network: 'testnet',
      protocolHash: 'PtSeouLou',
      pool: 1_000_000n,
      ownShare: 200_000n,
      bakerFee: 80_000n,
      distributable: 720_000n,
      remainder: 3n,
      totalToSend: 719_997n,
      feeNumerator: 10n,
      feeDenominator: 100n,
      blockFeesIncluded: true,
      payoutFactorNumerator: 3n,
      payoutFactorDenominator: 1n,
      delegatorCount: 2,
    },
    lines: [
      line(ALICE, 400_000n),
      line(BOB, 319_997n),
    ],
    batches: [
      {
        bakerId: BAKER,
        cycle,
        index: 0,
        transfers: [
          transfer(ALICE, 400_000n),
          transfer(BOB, 319_997n),
        ],
        totalAmount: 719_997n,
        totalFees: 800n,
        totalBurn: 0n,
        totalGas: 2_000n,
        totalStorage: 0n,
      },
    ],
  };
}

function line(address: string, amount: bigint): NewDistribution['lines'][number] {
  return {
    bakerId: BAKER,
    cycle: 1336,
    address,
    delegatedBalanceMutez: 10_000_000n,
    grossMutez: amount + 40_000n,
    commissionMutez: 40_000n,
    netMutez: amount,
    carriedInMutez: 0n,
    payableMutez: amount,
    transferCostMutez: 400n,
    minimumMutez: 1_200n,
    withheldMutez: 0n,
    amountMutez: amount,
    carriedOutMutez: 0n,
    emptied: false,
  };
}

function transfer(address: string, amount: bigint) {
  return {
    address,
    amountMutez: amount,
    feeMutez: 400n,
    gasLimit: 1_000n,
    storageLimit: 0n,
    burnMutez: 0n,
  };
}

export function newSettlement(settlementId = 'ticket-1'): NewDebtSettlement {
  return {
    bakerId: BAKER,
    settlementId,
    network: 'testnet',
    protocolHash: 'PtSeouLou',
    actor: 'rafael',
    reason: 'delegador pediu por e-mail',
    lines: [
      {
        address: ALICE,
        amountMutez: 900n,
        feeMutez: 400n,
        gasLimit: 1_000n,
        storageLimit: 0n,
        burnMutez: 0n,
      },
    ],
    totalAmount: 900n,
    totalFees: 400n,
    totalBurn: 0n,
  };
}

/** A store carrying an open debt of 900 mutez for Alice. */
export async function withOpenDebt(store: PayoutStore): Promise<void> {
  await store.createDistribution(newDistribution(1330));
  await store.settleDistribution({
    bakerId: BAKER,
    cycle: 1330,
    status: 'settled',
    lines: [],
    carryOver: new Map([[ALICE, 900n]]),
    at: new Date('2026-08-01T00:00:00Z'),
  });
}
