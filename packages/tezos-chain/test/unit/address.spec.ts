import {
  assertPayableAddress,
  getAddressKind,
  isValidOperationHash,
  isValidTezosAddress,
} from '../../src/address';
import { AddressError } from '../../src/errors';

// Real addresses read from mainnet on 2026-08-30.
const TZ1 = 'tz1fwnfJNgiDACshK9avfRfFbMaXrs3ghoJa';
const TZ4_BAKER = 'tz4TUryBw8kUQm7ScAtMx6FhBH5WswY1TZrE';
const KT1 = 'KT1TxqZ8QtKvLu3V3JH7Gx58n7Co8pgtpQU5';
const DELEGATOR = 'tz1Ysx7W3sNGBijnkpjCvaaJSdKqSAAAiNz2';
// The same delegator with the last character changed. Correct prefix, correct
// length, valid base58 alphabet — every regex in the old code accepts it.
const DELEGATOR_ONE_DIGIT_WRONG = 'tz1Ysx7W3sNGBijnkpjCvaaJSdKqSAAAiNz3';

describe('address validation', () => {
  it('accepts tz4, which the old regex list rejected', () => {
    expect(isValidTezosAddress(TZ4_BAKER)).toBe(true);
    expect(assertPayableAddress(TZ4_BAKER)).toBe('tz4');
    expect(getAddressKind(TZ4_BAKER)).toBe('tz4');
  });

  it('accepts tz1 and KT1', () => {
    expect(assertPayableAddress(TZ1)).toBe('tz1');
    expect(assertPayableAddress(KT1)).toBe('KT1');
  });

  it('rejects an address with a wrong digit, which a regex cannot catch', () => {
    const regexThatWouldPass = /^tz1[1-9A-HJ-NP-Za-km-z]{33}$/;
    expect(regexThatWouldPass.test(DELEGATOR)).toBe(true);
    expect(regexThatWouldPass.test(DELEGATOR_ONE_DIGIT_WRONG)).toBe(true);

    expect(isValidTezosAddress(DELEGATOR)).toBe(true);
    expect(isValidTezosAddress(DELEGATOR_ONE_DIGIT_WRONG)).toBe(false);
    expect(() => assertPayableAddress(DELEGATOR_ONE_DIGIT_WRONG)).toThrow(AddressError);
    expect(() => assertPayableAddress(DELEGATOR_ONE_DIGIT_WRONG)).toThrow(/checksum/);
  });

  it('says "not supported yet" for tz5 instead of "malformed"', () => {
    expect(() => assertPayableAddress('tz5abcdefghijklmnopqrstuvwxyz01234567')).toThrow(
      /not supported by this suite yet/,
    );
  });

  it('validates operation hashes by checksum too', () => {
    expect(
      isValidOperationHash('opCdNE9wDRzYxKKRYuqxawTtzScJFFauXihZa7aszBHqpuZyFsk'),
    ).toBe(true);
    expect(
      isValidOperationHash('opCdNE9wDRzYxKKRYuqxawTtzScJFFauXihZa7aszBHqpuZyFsm'),
    ).toBe(false);
  });
});
