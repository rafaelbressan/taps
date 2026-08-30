import { validateAddress, validateOperation, ValidationResult } from '@taquito/utils';
import { AddressError } from './errors';

/**
 * No address regex lives in this package. A regex checks prefix and length;
 * it cannot check the base58 checksum, so it accepts an address with one
 * digit swapped — which on a payout means the money goes nowhere recoverable.
 * `validateAddress` from @taquito/utils checks prefix, length and checksum.
 */

export type ImplicitAddressKind = 'tz1' | 'tz2' | 'tz3' | 'tz4';
export type AddressKind = ImplicitAddressKind | 'KT1';

/** Prefixes the chain understands and this package is willing to pay. */
const PAYABLE_PREFIXES: readonly AddressKind[] = ['tz1', 'tz2', 'tz3', 'tz4', 'KT1'];

/**
 * Registered but deliberately unsupported. Recognising it lets us answer
 * "address type not supported yet" instead of "malformed address" — one is
 * a correct message, the other is a bug report about data corruption.
 */
const KNOWN_UNSUPPORTED_PREFIXES = ['tz5'] as const;

export function isValidTezosAddress(address: string): boolean {
  return validateAddress(address) === ValidationResult.VALID;
}

export function getAddressKind(address: string): AddressKind | null {
  if (!isValidTezosAddress(address)) return null;
  const prefix = PAYABLE_PREFIXES.find((p) => address.startsWith(p));
  return prefix ?? null;
}

function describe(result: ValidationResult): string {
  switch (result) {
    case ValidationResult.NO_PREFIX_MATCHED:
      return 'unknown address prefix';
    case ValidationResult.INVALID_CHECKSUM:
      return 'base58 checksum does not match (a digit is wrong)';
    case ValidationResult.INVALID_LENGTH:
      return 'wrong length';
    case ValidationResult.PREFIX_NOT_ALLOWED:
      return 'prefix not allowed here';
    case ValidationResult.INVALID_ENCODING:
      return 'not valid base58';
    default:
      return 'rejected by @taquito/utils';
  }
}

/**
 * Throws unless the address can receive a payout. tz4 (BLS) is accepted:
 * `allow_tz4_delegate_enable` is true on mainnet, tz4 bakers are active, and
 * a simulated transfer to a fresh tz4 costs the same gas as to a tz1.
 */
export function assertPayableAddress(address: string): AddressKind {
  const unsupported = KNOWN_UNSUPPORTED_PREFIXES.find((p) => address.startsWith(p));
  if (unsupported) {
    throw new AddressError(
      address,
      `${unsupported} addresses are recognised by the protocol but not supported by this suite yet`,
    );
  }

  const result = validateAddress(address);
  if (result !== ValidationResult.VALID) {
    throw new AddressError(address, describe(result));
  }

  const kind = PAYABLE_PREFIXES.find((p) => address.startsWith(p));
  if (!kind) {
    throw new AddressError(address, 'valid Tezos address but not a payout destination');
  }
  return kind;
}

/** Operation hashes have their own checksum; @taquito/utils checks it. */
export function isValidOperationHash(hash: string): boolean {
  return validateOperation(hash) === ValidationResult.VALID;
}
