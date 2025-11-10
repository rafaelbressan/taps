import {
  isValidTezosAddress,
  getAddressType,
  isValidTransactionHash,
  mutezToTez,
  tezToMutez,
  TEZOS_CONSTANTS,
} from './tezos.config';

describe('Tezos Config', () => {
  describe('isValidTezosAddress', () => {
    it('should validate tz1 address', () => {
      expect(isValidTezosAddress('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb')).toBe(true);
    });

    it('should validate tz2 address', () => {
      expect(isValidTezosAddress('tz2TSvNTh2epDMhZHrw73nV9piBX7kLZ9K9m')).toBe(true);
    });

    it('should validate tz3 address', () => {
      expect(isValidTezosAddress('tz3VEZ4k6a4Wx42iyev6i2aVAptTRLEAivNN')).toBe(true);
    });

    it('should validate KT1 address', () => {
      expect(isValidTezosAddress('KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn')).toBe(true);
    });

    it('should reject invalid address', () => {
      expect(isValidTezosAddress('invalid')).toBe(false);
      expect(isValidTezosAddress('tz1')).toBe(false);
      expect(isValidTezosAddress('')).toBe(false);
    });
  });

  describe('getAddressType', () => {
    it('should identify tz1 address', () => {
      expect(getAddressType('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb')).toBe('tz1');
    });

    it('should identify tz2 address', () => {
      expect(getAddressType('tz2TSvNTh2epDMhZHrw73nV9piBX7kLZ9K9m')).toBe('tz2');
    });

    it('should identify tz3 address', () => {
      expect(getAddressType('tz3VEZ4k6a4Wx42iyev6i2aVAptTRLEAivNN')).toBe('tz3');
    });

    it('should identify KT1 address', () => {
      expect(getAddressType('KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn')).toBe('KT1');
    });

    it('should return null for invalid address', () => {
      expect(getAddressType('invalid')).toBe(null);
    });
  });

  describe('isValidTransactionHash', () => {
    it('should validate operation hash', () => {
      expect(isValidTransactionHash('oo1abc123def456ghi789jkl012mno345pqr678stu901vwx')).toBe(true);
    });

    it('should reject invalid hash', () => {
      expect(isValidTransactionHash('invalid')).toBe(false);
      expect(isValidTransactionHash('abc123')).toBe(false);
      expect(isValidTransactionHash('')).toBe(false);
    });

    it('should reject hash with invalid length', () => {
      expect(isValidTransactionHash('o1abc')).toBe(false); // too short
    });
  });

  describe('mutezToTez', () => {
    it('should convert mutez to tez', () => {
      expect(mutezToTez(1000000)).toBe(1);
      expect(mutezToTez(500000)).toBe(0.5);
      expect(mutezToTez(0)).toBe(0);
    });

    it('should handle large amounts', () => {
      expect(mutezToTez(1234567890)).toBe(1234.56789);
    });
  });

  describe('tezToMutez', () => {
    it('should convert tez to mutez', () => {
      expect(tezToMutez(1)).toBe(1000000);
      expect(tezToMutez(0.5)).toBe(500000);
      expect(tezToMutez(0)).toBe(0);
    });

    it('should handle decimals correctly', () => {
      expect(tezToMutez(1.123456)).toBe(1123456);
    });

    it('should floor fractional mutez', () => {
      expect(tezToMutez(0.0000001)).toBe(0);
      expect(tezToMutez(0.000001)).toBe(1);
    });
  });

  describe('TEZOS_CONSTANTS', () => {
    it('should have correct mutez per tez', () => {
      expect(TEZOS_CONSTANTS.MUTEZ_PER_TEZ).toBe(1000000);
    });

    it('should have valid gas limits', () => {
      expect(TEZOS_CONSTANTS.DEFAULT_GAS_LIMIT).toBeGreaterThan(0);
      expect(TEZOS_CONSTANTS.DEFAULT_STORAGE_LIMIT).toBeGreaterThan(0);
    });

    it('should have valid batch limits', () => {
      expect(TEZOS_CONSTANTS.MAX_BATCH_SIZE).toBeGreaterThan(0);
      expect(TEZOS_CONSTANTS.MAX_BATCH_OPERATIONS).toBeGreaterThan(0);
    });
  });
});
