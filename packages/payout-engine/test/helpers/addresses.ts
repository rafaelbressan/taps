import { createHash } from 'node:crypto';
import { b58Encode, PrefixV2 } from '@taquito/utils';

/**
 * Real addresses, with real checksums, generated deterministically.
 *
 * A test that uses `tz1delegator1...` proves nothing about a path that calls
 * `validateAddress`: the checksum is what the validator checks, and a
 * placeholder never has one.
 */
/**
 * A hash, not a linear congruential generator: the low byte of an LCG modulo
 * 2^32 has a period of 256, so 60 258 seeds produced 256 distinct addresses
 * and the tests collided instead of covering the case they claimed to.
 */
function bytes(seed: number, length = 20): Buffer {
  return createHash('sha256').update(`taps-test-address:${seed}`).digest().subarray(0, length);
}

export function tz1(seed: number): string {
  return b58Encode(bytes(seed), PrefixV2.Ed25519PublicKeyHash);
}

/** tz4 (BLS) is payable: simulated on mainnet as `applied`, same gas as tz1. */
export function tz4(seed: number): string {
  return b58Encode(bytes(seed), PrefixV2.BLS12_381PublicKeyHash);
}

export function kt1(seed: number): string {
  return b58Encode(bytes(seed), PrefixV2.ContractHash);
}

export function operationHash(seed: number): string {
  return b58Encode(bytes(seed, 32), PrefixV2.OperationHash);
}

export function blockHash(seed: number): string {
  return b58Encode(bytes(seed + 7777, 32), PrefixV2.BlockHash);
}
