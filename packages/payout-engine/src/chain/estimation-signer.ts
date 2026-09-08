import type { Signer } from '@taquito/taquito';
import { getPkhfromPk } from '@taquito/utils';
import { InvariantViolationError } from '@tezos-suite/chain';
import {
  EstimationSignerCannotSignError,
  PayoutAccountNotRevealedError,
} from '../errors';
import type { ManagerKeySource } from './rpc';

/**
 * O signer da ESTIMATIVA — o que não assina.
 *
 * Two signing surfaces exist in this system and they are not the same thing:
 *
 *   estimation   Taquito builds the batch and asks the node to simulate it.
 *                It reads `signer.publicKeyHash()` for the source and
 *                `signer.publicKey()` for a possible reveal, and it signs
 *                NOTHING: `RPCEstimateProvider.calculateEstimates` sends the
 *                operation to `run_operation` under `STUB_SIGNATURE`.
 *   injection    `RpcBatchInjector` forges locally, parses the bytes back,
 *                compares them with the plan, and only then asks
 *                `OctezRemoteSigner.signOperation` for `0x03 || bytes`.
 *
 * Taquito has one slot for both and its default occupant is `NoopSigner`,
 * which throws "No signer has been configured" on every method — the error
 * BRES-133 hit on every cycle, at the estimate, with the injection side
 * correctly wired all along.
 *
 * Filling that slot with the real signer would have been the short fix and
 * the wrong one: it hands a spending capability to the half of the code that
 * plans, one `send()` away from a batch that never passed
 * `assertForgedMatchesPlan`. This class fills it with exactly what estimation
 * needs and nothing else — two reads, and a `sign()` that throws.
 *
 * Where each read comes from is a decision, not a detail:
 *
 * - `publicKeyHash()` is the configured payout address. Never discovered.
 * - `publicKey()` is the account's `manager_key`, READ FROM THE CHAIN, not
 *   from `GET /keys/<pkh>` on the signer. The signer's copy would be one more
 *   authenticated round trip per estimate chunk, and it answers what the
 *   signer holds; the chain answers what the chain will accept, which is the
 *   only fact this path actually needs. When the chain answers `null` the
 *   account was never revealed, and only then is the signer asked — it is the
 *   one place the key still exists, and the first payout of a new payout key
 *   cannot be priced without it (BRES-137). The reveal that follows is its
 *   own operation, built by the injector, never part of a payout batch.
 *
 * The watermark question does not arise on this side at all. `0x03` belongs
 * to `signOperation`, which is the only place a byte is ever signed, and it
 * is the one the signer's `--magic-bytes 0x03` admits.
 */
/** Just the public half. Narrower than `PayoutSigner` on purpose. */
export interface PublicKeySource {
  publicKey(): Promise<string>;
}

export class EstimationSigner implements Signer {
  private cachedPublicKey: string | null = null;

  constructor(
    private readonly payoutAddress: string,
    private readonly chain: ManagerKeySource,
    /**
     * Where the public key comes from while the chain still has none.
     *
     * Only reachable before the account has ever been revealed, which is
     * exactly the state a payout key is in on the day it is made. The chain
     * cannot answer for an account it has never seen sign, and estimating
     * the first payout needs the key to price the reveal (BRES-137).
     *
     * `GET /keys/<pkh>` on the signer is unauthenticated — it returns the
     * public half — so this costs a plain round trip, not a signature.
     */
    private readonly signerOfLastResort?: PublicKeySource,
  ) {}

  async publicKeyHash(): Promise<string> {
    return this.payoutAddress;
  }

  /**
   * Cached after the first read, and only on success: the chunked estimator
   * makes one `estimate.batch()` call per chunk and each of them asks. A
   * failure is not cached — an account revealed between two runs must be
   * seen.
   */
  async publicKey(): Promise<string> {
    if (this.cachedPublicKey !== null) return this.cachedPublicKey;

    const managerKey = await this.chain.getManagerKey(this.payoutAddress);
    // An account the chain has never seen sign has no key to give. Asking
    // the signer is the only remaining source, and the check below is what
    // keeps that from being a weaker answer than the chain's.
    const publicKey = managerKey ?? (await this.signerOfLastResort?.publicKey());
    if (publicKey === undefined || publicKey === null) {
      throw new PayoutAccountNotRevealedError(this.payoutAddress);
    }

    // Cheap, and it is the one check that makes a wrong answer here
    // impossible to carry: a public key that does not hash to the payout
    // address is either another account's or a node that is not on the
    // network this run thinks it is on. It matters more, not less, when the
    // key came from the signer instead of the chain.
    const derived = getPkhfromPk(publicKey);
    if (derived !== this.payoutAddress) {
      throw new InvariantViolationError(
        'the public key offered for the payout account hashes to it',
        `${this.payoutAddress} answered with a public key that hashes to ${derived}`,
      );
    }

    // Only the chain's answer is cached. A key borrowed from the signer is
    // provisional by nature: the moment the reveal lands, the chain becomes
    // the authority again and must be re-read.
    if (managerKey !== null) this.cachedPublicKey = managerKey;
    return publicKey;
  }

  /** Estimation is simulated under a stub signature. Nothing signs here. */
  async sign(): Promise<never> {
    throw new EstimationSignerCannotSignError('sign');
  }

  /** There is no local key anywhere in this package, by decision. */
  async secretKey(): Promise<never> {
    throw new EstimationSignerCannotSignError('secretKey');
  }

  /**
   * A BLS proof of possession is a signature over the public key, asked for
   * when Taquito builds a `tz4` reveal. That reveal is refused earlier, in
   * `publicKey()`, and the method exists here so the refusal is explicit
   * rather than a `TypeError` on an absent optional member.
   */
  async provePossession(): Promise<never> {
    throw new EstimationSignerCannotSignError('provePossession');
  }
}
