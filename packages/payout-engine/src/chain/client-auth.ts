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
 * The byte layout below — magic byte, then the request path, then the data —
 * is the layout this package signs over. It must be confirmed against the
 * signer actually deployed before the first run that moves funds; a mismatch
 * fails closed, with the signer refusing the request, which is the direction
 * a wrong guess should fail in.
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
