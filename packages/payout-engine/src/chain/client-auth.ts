import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { b58DecodeAndCheckPrefix, b58Encode, PrefixV2 } from '@taquito/utils';
import { ConfigurationError } from '@tezos-suite/chain';
import { blake2b } from 'blakejs';
import type { SignerAuthenticator, SignerRequest } from './signer';

/**
 * The client credential for `octez-signer --require-authentication`.
 *
 * Read this before assuming it weakens the custody decision: this key proves
 * to the signer WHO is asking. It is not the key that holds the funds, it
 * cannot produce a valid Tezos signature for a transfer, and a host that
 * holds only this key can move nothing. The payout key never leaves the
 * signer host.
 *
 * STATUS: accepted by `octez-signer` 25.1 with `--require-authentication`,
 * proven against the real binary (see `test/integration/octez-signer-auth.mjs`).
 *
 * The layout is the one Octez checks in `src/lib_signer_services/signer_messages.ml`
 * at tag `octez-v25.1`:
 *
 *     to_sign = 0x04 || tag || Signature.Public_key_hash.to_bytes pkh || data
 *
 * with `tag = 1` for a signing request, and `to_bytes` being the 21 bytes of
 * the tagged union (`raw_encoding` in `src/lib_crypto/signature_v2.ml`):
 * one curve byte (tz1 = 0, tz2 = 1, tz3 = 2, tz4 = 3) then the 20-byte hash.
 *
 * What earlier attempts were missing is not in that layout at all: **a Tezos
 * signature is never over the message, it is over BLAKE2b-256 of the message.**
 * `Signature.check` on the signer side hashes `to_sign` before verifying, so
 * the client has to hash before signing. Sign the layout above raw — as the
 * spec text alone suggests — and the signer answers `invalid authentication
 * signature`, with the layout perfectly correct. That is why sweeping tags,
 * prefixes and pkh encodings never converged.
 */

/** Distinct from 0x03: an authentication signature is not an operation. */
export const AUTHENTICATION_MAGIC_BYTE = 0x04;

/** `Sign.Request = Make_authenticated_signing_request (tag = 1)`. */
export const SIGN_REQUEST_TAG = 0x01;

/** BLAKE2b digest size, in bytes, of every Tezos signature payload. */
const TEZOS_DIGEST_BYTES = 32;

/**
 * The curve byte `Signature.Public_key_hash.raw_encoding` puts in front of the
 * 20-byte hash. Same order as the `union` cases in `signature_v2.ml`, and tz4
 * is in it: a payout address on BLS authenticates like any other.
 */
const PKH_CURVE_TAG: ReadonlyMap<PrefixV2, number> = new Map([
  [PrefixV2.Ed25519PublicKeyHash, 0x00],
  [PrefixV2.Secp256k1PublicKeyHash, 0x01],
  [PrefixV2.P256PublicKeyHash, 0x02],
  [PrefixV2.BLS12_381PublicKeyHash, 0x03],
]);

const PKH_PREFIXES = [...PKH_CURVE_TAG.keys()] as const;

/** `Signature.Public_key_hash.to_bytes`: curve byte then the 20-byte hash. */
export function encodePublicKeyHash(publicKeyHash: string): Buffer {
  let payload: Uint8Array;
  let prefix: PrefixV2;
  try {
    [payload, prefix] = b58DecodeAndCheckPrefix(publicKeyHash, PKH_PREFIXES);
  } catch (cause) {
    throw new ConfigurationError(
      `${JSON.stringify(publicKeyHash)} is not a tz1/tz2/tz3/tz4 address ` +
        `(${(cause as Error).message})`,
    );
  }
  const tag = PKH_CURVE_TAG.get(prefix);
  if (tag === undefined) {
    throw new ConfigurationError(
      `${publicKeyHash} decodes to ${prefix}, which the signer authentication layout does not cover`,
    );
  }
  return Buffer.concat([Buffer.from([tag]), Buffer.from(payload)]);
}

export function buildAuthenticationPayload(request: SignerRequest): Buffer {
  return Buffer.concat([
    Buffer.from([AUTHENTICATION_MAGIC_BYTE, SIGN_REQUEST_TAG]),
    encodePublicKeyHash(request.publicKeyHash),
    Buffer.from(request.dataHex, 'hex'),
  ]);
}

/** PKCS#8 wrapper for a raw Ed25519 seed, so node:crypto will take it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SEED_BYTES = 32;

function seedFrom(clientAuthKey: string): Buffer {
  let decoded: Uint8Array;
  try {
    decoded = b58DecodeAndCheckPrefix(
      clientAuthKey,
      [PrefixV2.Ed25519Seed, PrefixV2.Ed25519SecretKey],
      true,
    );
  } catch (cause) {
    throw new ConfigurationError(
      'the signer client credential is not a base58 Ed25519 secret key ' +
        `(${(cause as Error).message})`,
    );
  }
  // The 64-byte form is seed || public key; only the seed is the secret.
  const seed = Buffer.from(decoded.subarray(0, ED25519_SEED_BYTES));
  if (seed.length !== ED25519_SEED_BYTES) {
    throw new ConfigurationError(
      `the signer client credential decodes to ${seed.length} bytes, expected at least ${ED25519_SEED_BYTES}`,
    );
  }
  return seed;
}

export class Ed25519ClientAuthenticator implements SignerAuthenticator {
  private readonly key;

  constructor(
    clientAuthKey: string,
    private readonly buildPayload: (
      request: SignerRequest,
    ) => Buffer = buildAuthenticationPayload,
  ) {
    this.key = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seedFrom(clientAuthKey)]),
      format: 'der',
      type: 'pkcs8',
    });
  }

  async authenticate(request: SignerRequest): Promise<string> {
    // BLAKE2b-256 first. `Signature.check` on the signer hashes `to_sign` the
    // same way; signing the payload raw fails with the layout still correct.
    const digest = Buffer.from(
      blake2b(this.buildPayload(request), undefined, TEZOS_DIGEST_BYTES),
    );
    const signature = cryptoSign(null, digest, this.key);
    return b58Encode(signature, PrefixV2.Ed25519Signature);
  }
}
