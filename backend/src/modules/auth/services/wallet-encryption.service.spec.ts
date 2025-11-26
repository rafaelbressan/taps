import { Test, TestingModule } from '@nestjs/testing';
import { WalletEncryptionService } from './wallet-encryption.service';

describe('WalletEncryptionService', () => {
  let service: WalletEncryptionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WalletEncryptionService],
    }).compile();

    service = module.get<WalletEncryptionService>(WalletEncryptionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('encryptWalletPassphrase and decryptWalletPassphrase', () => {
    it('should encrypt and decrypt passphrase', async () => {
      const passphrase = 'my-secret-wallet-passphrase';
      const userPassword = 'UserPassword123!';

      const encrypted = await service.encryptWalletPassphrase(passphrase, userPassword);

      expect(encrypted.phrase).toBeDefined();
      expect(encrypted.appPhrase).toBeDefined();
      expect(encrypted.walletHash).toBeDefined();
      expect(encrypted.walletSalt).toBeDefined();

      const decrypted = await service.decryptWalletPassphrase(encrypted, userPassword);

      expect(decrypted).toBe(passphrase);
    });

    it('should encrypt with app seed', async () => {
      const passphrase = 'my-secret-wallet-passphrase';
      const userPassword = 'UserPassword123!';
      const appSeed = 'app-secret-seed';

      const encrypted = await service.encryptWalletPassphrase(
        passphrase,
        userPassword,
        appSeed,
      );

      const decrypted = await service.decryptWalletPassphrase(
        encrypted,
        userPassword,
        appSeed,
      );

      expect(decrypted).toBe(passphrase);
    });

    it('should fail to decrypt with wrong password', async () => {
      const passphrase = 'my-secret-wallet-passphrase';
      const userPassword = 'UserPassword123!';
      const wrongPassword = 'WrongPassword456!';

      const encrypted = await service.encryptWalletPassphrase(passphrase, userPassword);

      await expect(
        service.decryptWalletPassphrase(encrypted, wrongPassword),
      ).rejects.toThrow();
    });

    it('should fail to decrypt with wrong app seed', async () => {
      const passphrase = 'my-secret-wallet-passphrase';
      const userPassword = 'UserPassword123!';
      const appSeed1 = 'app-seed-1';
      const appSeed2 = 'app-seed-2';

      const encrypted = await service.encryptWalletPassphrase(
        passphrase,
        userPassword,
        appSeed1,
      );

      await expect(
        service.decryptWalletPassphrase(encrypted, userPassword, appSeed2),
      ).rejects.toThrow();
    });
  });

  describe('hashWalletPassphrase', () => {
    it('should hash passphrase with salt', () => {
      const passphrase = 'my-passphrase';
      const salt = 'my-salt';

      const hash = service.hashWalletPassphrase(passphrase, salt);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(128); // SHA-512 hex length
    });

    it('should generate different hashes for different salts', () => {
      const passphrase = 'my-passphrase';
      const salt1 = 'salt1';
      const salt2 = 'salt2';

      const hash1 = service.hashWalletPassphrase(passphrase, salt1);
      const hash2 = service.hashWalletPassphrase(passphrase, salt2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyWalletPassphrase', () => {
    it('should verify correct passphrase', () => {
      const passphrase = 'my-passphrase';
      const salt = 'my-salt';
      const hash = service.hashWalletPassphrase(passphrase, salt);

      const isValid = service.verifyWalletPassphrase(passphrase, hash, salt);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect passphrase', () => {
      const passphrase = 'correct-passphrase';
      const wrongPassphrase = 'wrong-passphrase';
      const salt = 'my-salt';
      const hash = service.hashWalletPassphrase(passphrase, salt);

      const isValid = service.verifyWalletPassphrase(wrongPassphrase, hash, salt);

      expect(isValid).toBe(false);
    });
  });
});
