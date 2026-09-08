import { estimateTransfers, type Recipient } from '../../src/batch/estimate';
import { InvariantViolationError } from '../../src/errors';

/**
 * Counting the reveal (BRES-137).
 *
 * An account that has never published its public key cannot send anything,
 * and Taquito puts that reveal in front of the batch it is asked to estimate.
 * Reading the extra entry as a broken invariant meant the first payout of
 * every new payout key failed — and failed talking about arithmetic instead
 * of about the account.
 *
 * The count is checked against the CHAIN, never inferred from the difference:
 * an answer that is one too long for any other reason has to stay a refusal,
 * because the alternative is pairing every estimate with the wrong recipient.
 */

const ALICE = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb';
const BOB = 'tz1KqTpEZ7Yob7QbPE4Hy4Wo8fHG8LhKxZSx';

interface FakeEstimate {
  gasLimit: number;
  storageLimit: number;
  suggestedFeeMutez: number;
  burnFeeMutez: number;
}

function estimate(gas: number, fee: number): FakeEstimate {
  return { gasLimit: gas, storageLimit: 0, suggestedFeeMutez: fee, burnFeeMutez: 0 };
}

/** Just enough TezosToolkit for the code under test. */
function toolkit(managerKey: string | null, estimates: FakeEstimate[]) {
  return {
    signer: { publicKeyHash: async () => ALICE },
    rpc: { getManagerKey: async () => managerKey },
    estimate: { batch: async () => estimates },
  } as never;
}

const recipients: Recipient[] = [
  { address: ALICE, amount: 1_000_000n },
  { address: BOB, amount: 2_000_000n },
];

describe('estimating for an account that was never revealed', () => {
  it('drops the reveal from the transfers and reports its cost', async () => {
    const result = await estimateTransfers(
      toolkit(null, [estimate(1_000, 374), estimate(2_169, 488), estimate(2_169, 489)]),
      recipients,
    );

    expect(result.reveal).toEqual({
      gasLimit: 1_000n,
      storageLimit: 0n,
      feeMutez: 374n,
    });
    expect(result.transfers).toHaveLength(2);
    // The offset is the whole point: without it Alice would be priced with
    // the reveal's gas and Bob with Alice's.
    expect(result.transfers[0]!.address).toBe(ALICE);
    expect(result.transfers[0]!.feeMutez).toBe(488n);
    expect(result.transfers[1]!.address).toBe(BOB);
    expect(result.transfers[1]!.feeMutez).toBe(489n);
  });

  it('reports no reveal when the account already published its key', async () => {
    const result = await estimateTransfers(
      toolkit('edpkSomething', [estimate(2_169, 488), estimate(2_169, 489)]),
      recipients,
    );

    expect(result.reveal).toBeNull();
    expect(result.transfers[0]!.feeMutez).toBe(488n);
  });

  it('still refuses a count that is wrong for any other reason', async () => {
    // Revealed, so nothing explains the extra entry. Pairing them anyway
    // would pay one delegator with another's numbers, silently.
    await expect(
      estimateTransfers(
        toolkit('edpkSomething', [estimate(1, 1), estimate(2, 2), estimate(3, 3)]),
        recipients,
      ),
    ).rejects.toThrow(InvariantViolationError);

    // Unrevealed and one short: the reveal is missing, not the transfer.
    await expect(
      estimateTransfers(toolkit(null, [estimate(1, 1), estimate(2, 2)]), recipients),
    ).rejects.toThrow(InvariantViolationError);
  });

  it('says which account and what it expected', async () => {
    await expect(
      estimateTransfers(toolkit(null, [estimate(1, 1)]), recipients),
    ).rejects.toThrow(/never revealed/);
  });
});
