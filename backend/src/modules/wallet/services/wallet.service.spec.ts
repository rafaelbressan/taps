import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { InMemorySigner } from '@taquito/signer';

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WalletService],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateAddress', () => {
    it('should validate tz1 address', () => {
      const address = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb';
      expect(service.validateAddress(address)).toBe(true);
    });

    it('should validate tz2 address', () => {
      const address = 'tz2TSvNTh2epDMhZHrw73nV9piBX7kLZ9K9m';
      expect(service.validateAddress(address)).toBe(true);
    });

    it('should validate tz3 address', () => {
      const address = 'tz3VEZ4k6a4Wx42iyev6i2aVAptTRLEAivNN';
      expect(service.validateAddress(address)).toBe(true);
    });

    it('should validate KT1 address', () => {
      const address = 'KT1PWx2mnDueood7fEmfbBDKx1D9BAnnXitn';
      expect(service.validateAddress(address)).toBe(true);
    });

    it('should reject invalid address', () => {
      const address = 'invalid_address';
      expect(service.validateAddress(address)).toBe(false);
    });

    it('should reject empty address', () => {
      expect(service.validateAddress('')).toBe(false);
    });
  });

  describe('generateMnemonic', () => {
    it('should generate valid mnemonic', () => {
      const mnemonic = service.generateMnemonic();
      expect(mnemonic).toBeDefined();
      expect(typeof mnemonic).toBe('string');

      const words = mnemonic.split(' ');
      expect([12, 15, 18, 21, 24]).toContain(words.length);
    });
  });

  describe('validateMnemonic', () => {
    it('should validate 12-word mnemonic', () => {
      const mnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      expect(service.validateMnemonic(mnemonic)).toBe(true);
    });

    it('should validate 24-word mnemonic', () => {
      const mnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
      expect(service.validateMnemonic(mnemonic)).toBe(true);
    });

    it('should reject invalid word count', () => {
      const mnemonic = 'abandon abandon abandon';
      expect(service.validateMnemonic(mnemonic)).toBe(false);
    });
  });

  describe('validateSecretKey', () => {
    it('should validate edsk secret key', () => {
      const secretKey = 'edskRuR1azSfboG86YPTyxrQgosh5zChf5bVDmptqLTb5EuXAm9rsnDYfTKhq7rDQujdn5WWzwUMeV3agaZ6J2vPQT58jJAJPi';
      expect(service.validateSecretKey(secretKey)).toBe(true);
    });

    it('should validate spsk secret key', () => {
      const secretKey = 'spsk2gY42H8KgePvzWWqhMsNf8VcBsCXHp4nPW2xWRZgVTQzLd9J7X';
      expect(service.validateSecretKey(secretKey)).toBe(true);
    });

    it('should reject invalid secret key', () => {
      const secretKey = 'invalid_key';
      expect(service.validateSecretKey(secretKey)).toBe(false);
    });
  });

  describe('encryptWallet and decryptWallet', () => {
    it('should encrypt and decrypt wallet', async () => {
      const secretKey =
        'edskRuR1azSfboG86YPTyxrQgosh5zChf5bVDmptqLTb5EuXAm9rsnDYfTKhq7rDQujdn5WWzwUMeV3agaZ6J2vPQT58jJAJPi';
      const password = 'test_password_123';

      const encrypted = await service.encryptWallet(secretKey, password);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.salt).toBeDefined();
      expect(encrypted.tag).toBeDefined();

      const decrypted = await service.decryptWallet(encrypted, password);

      expect(decrypted).toBe(secretKey);
    });

    it('should encrypt with app seed', async () => {
      const secretKey =
        'edskRuR1azSfboG86YPTyxrQgosh5zChf5bVDmptqLTb5EuXAm9rsnDYfTKhq7rDQujdn5WWzwUMeV3agaZ6J2vPQT58jJAJPi';
      const password = 'test_password_123';
      const appSeed = 'app_secret_seed';

      const encrypted = await service.encryptWallet(
        secretKey,
        password,
        appSeed,
      );

      const decrypted = await service.decryptWallet(
        encrypted,
        password,
        appSeed,
      );

      expect(decrypted).toBe(secretKey);
    });

    it('should fail to decrypt with wrong password', async () => {
      const secretKey =
        'edskRuR1azSfboG86YPTyxrQgosh5zChf5bVDmptqLTb5EuXAm9rsnDYfTKhq7rDQujdn5WWzwUMeV3agaZ6J2vPQT58jJAJPi';
      const password = 'correct_password';
      const wrongPassword = 'wrong_password';

      const encrypted = await service.encryptWallet(secretKey, password);

      await expect(
        service.decryptWallet(encrypted, wrongPassword),
      ).rejects.toThrow();
    });

    it('should fail to decrypt with wrong app seed', async () => {
      const secretKey =
        'edskRuR1azSfboG86YPTyxrQgosh5zChf5bVDmptqLTb5EuXAm9rsnDYfTKhq7rDQujdn5WWzwUMeV3agaZ6J2vPQT58jJAJPi';
      const password = 'password';
      const appSeed1 = 'seed1';
      const appSeed2 = 'seed2';

      const encrypted = await service.encryptWallet(
        secretKey,
        password,
        appSeed1,
      );

      await expect(
        service.decryptWallet(encrypted, password, appSeed2),
      ).rejects.toThrow();
    });
  });

  describe('hashPassword and verifyPassword', () => {
    it('should hash and verify password', async () => {
      const password = 'secure_password_123';

      const hash = await service.hashPassword(password);
      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);

      const isValid = await service.verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject wrong password', async () => {
      const password = 'correct_password';
      const wrongPassword = 'wrong_password';

      const hash = await service.hashPassword(password);

      const isValid = await service.verifyPassword(wrongPassword, hash);
      expect(isValid).toBe(false);
    });
  });

  describe('generateSalt', () => {
    it('should generate unique salts', () => {
      const salt1 = service.generateSalt();
      const salt2 = service.generateSalt();

      expect(salt1).toBeDefined();
      expect(salt2).toBeDefined();
      expect(salt1).not.toBe(salt2);
      expect(salt1.length).toBe(64); // 32 bytes in hex
    });
  });
});
