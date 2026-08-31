import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { b58DecodeAndCheckPrefix, b58Encode, PrefixV2 } from '@taquito/utils';
import { ConfigurationError } from '@tezos-suite/chain';
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
 * STATUS: NOT ACCEPTED BY octez-signer YET. Do not turn on
 * `--require-authentication` expecting this to work.
 *
 * Tested on 2026-08-31 against a real `octez-signer` 25.1: every payload this
 * file produces comes back `invalid authentication signature`. The same
 * signer accepts the very same request with authentication off, so the URL,
 * the path, the body and the key derivation are all correct — only these
 * bytes are wrong.
 *
 * The layout Octez checks is, from `src/lib_signer_services/signer_messages.ml`
 * at tag `octez-v25.1`:
 *
 *     to_sign = 0x04 || tag || Signature.Public_key_hash.to_bytes pkh || data
 *
 * with `tag = 1` for a signing request. Reproducing that still fails, so
 * `Public_key_hash.to_bytes` is neither the 20 raw bytes nor the 21 bytes of
 * the tagged union — both were tried, along with the request path and a sweep
 * of leading bytes. What it actually encodes has to be read off a working
 * client before any of this is trusted.
 *
 * Until then the engine talks to a signer WITHOUT `--require-authentication`.
 * The defences that do hold are TLS, `--magic-bytes 0x03`, the destination
 * allowlist and the per-cycle ceiling.
 */

/** Distinct from 0x03: an authentication signature is not an operation. */
export const AUTHENTICATION_MAGIC_BYTE = 0x04;

export function buildAuthenticationPayload(request: SignerRequest): Buffer {
  return Buffer.concat([
    Buffer.from([AUTHENTICATION_MAGIC_BYTE]),
    Buffer.from(request.path, 'utf8'),
    Buffer.from(request.dataHex ?? '', 'hex'),
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
    const signature = cryptoSign(null, this.buildPayload(request), this.key);
    return b58Encode(signature, PrefixV2.Ed25519Signature);
  }
}
