import { Test, TestingModule } from '@nestjs/testing';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PasswordService],
    }).compile();

    service = module.get<PasswordService>(PasswordService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('hashPassword', () => {
    it('should hash password with bcrypt', async () => {
      const password = 'TestPassword123!';
      const hash = await service.hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(service.isBcryptHash(hash)).toBe(true);
    });

    it('should generate different hashes for same password', async () => {
      const password = 'TestPassword123!';
      const hash1 = await service.hashPassword(password);
      const hash2 = await service.hashPassword(password);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    it('should verify correct password', async () => {
      const password = 'TestPassword123!';
      const hash = await service.hashPassword(password);

      const isValid = await service.verifyPassword(password, hash);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'TestPassword123!';
      const wrongPassword = 'WrongPassword456!';
      const hash = await service.hashPassword(password);

      const isValid = await service.verifyPassword(wrongPassword, hash);

      expect(isValid).toBe(false);
    });
  });

  describe('verifyLegacyHash', () => {
    it('should verify legacy SHA-512 hash', async () => {
      const password = 'testpassword';
      const salt = 'testsalt';

      // Create legacy hash manually
      const crypto = require('crypto');
      const combined = password + salt;
      const expectedHash = crypto
        .createHash('sha512')
        .update(combined)
        .digest('hex')
        .toUpperCase();

      const isValid = await service.verifyLegacyHash(password, expectedHash, salt);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect legacy password', async () => {
      const password = 'testpassword';
      const wrongPassword = 'wrongpassword';
      const salt = 'testsalt';

      const crypto = require('crypto');
      const combined = password + salt;
      const hash = crypto
        .createHash('sha512')
        .update(combined)
        .digest('hex')
        .toUpperCase();

      const isValid = await service.verifyLegacyHash(wrongPassword, hash, salt);

      expect(isValid).toBe(false);
    });
  });

  describe('isBcryptHash', () => {
    it('should identify bcrypt hash', async () => {
      const hash = await service.hashPassword('test');
      expect(service.isBcryptHash(hash)).toBe(true);
    });

    it('should identify non-bcrypt hash', () => {
      const legacyHash = 'ABC123DEF456';
      expect(service.isBcryptHash(legacyHash)).toBe(false);
    });
  });

  describe('validatePasswordStrength', () => {
    it('should accept strong password', () => {
      const password = 'StrongPass123!';
      const result = service.validatePasswordStrength(password);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject password without uppercase', () => {
      const password = 'weakpass123!';
      const result = service.validatePasswordStrength(password);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one uppercase letter');
    });

    it('should reject password without lowercase', () => {
      const password = 'WEAKPASS123!';
      const result = service.validatePasswordStrength(password);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one lowercase letter');
    });

    it('should reject password without number', () => {
      const password = 'WeakPassword!';
      const result = service.validatePasswordStrength(password);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one number');
    });

    it('should reject short password', () => {
      const password = 'Pass1!';
      const result = service.validatePasswordStrength(password);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters long');
    });
  });

  describe('needsMigration', () => {
    it('should identify hash that needs migration', () => {
      const legacyHash = 'ABC123DEF456';
      expect(service.needsMigration(legacyHash)).toBe(true);
    });

    it('should identify hash that does not need migration', async () => {
      const bcryptHash = await service.hashPassword('test');
      expect(service.needsMigration(bcryptHash)).toBe(false);
    });
  });
});
