import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { JwtAuthService } from './jwt-auth.service';
import { WalletEncryptionService } from './wallet-encryption.service';
import { SettingsRepository } from '../../../database/repositories';
import { SettingsEntity } from '../../../shared/entities';

describe('AuthService', () => {
  let service: AuthService;
  let passwordService: jest.Mocked<PasswordService>;
  let jwtService: jest.Mocked<JwtAuthService>;
  let walletService: jest.Mocked<WalletEncryptionService>;
  let settingsRepo: jest.Mocked<SettingsRepository>;

  const mockSettings = {
    bakerId: 'baker123',
    userName: 'testbaker',
    passHash: '$2b$12$hashedpassword',
    hashSalt: null,
    walletHash: 'wallethash',
    walletSalt: 'walletsalt',
    mode: 'simulation',
    hasWalletCredentials: () => true,
  } as SettingsEntity;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PasswordService,
          useValue: {
            hashPassword: jest.fn(),
            verifyPassword: jest.fn(),
            verifyLegacyHash: jest.fn(),
            isBcryptHash: jest.fn(),
            validatePasswordStrength: jest.fn(),
            needsMigration: jest.fn(),
          },
        },
        {
          provide: JwtAuthService,
          useValue: {
            generateToken: jest.fn(),
            verifyToken: jest.fn(),
            getTokenExpiration: jest.fn(),
          },
        },
        {
          provide: WalletEncryptionService,
          useValue: {
            encryptWalletPassphrase: jest.fn(),
            decryptWalletPassphrase: jest.fn(),
            verifyWalletPassphrase: jest.fn(),
          },
        },
        {
          provide: SettingsRepository,
          useValue: {
            findAll: jest.fn(),
            findByBakerId: jest.fn(),
            update: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    passwordService = module.get(PasswordService);
    jwtService = module.get(JwtAuthService);
    walletService = module.get(WalletEncryptionService);
    settingsRepo = module.get(SettingsRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateUser', () => {
    it('should validate user with bcrypt password', async () => {
      settingsRepo.findAll.mockResolvedValue([mockSettings]);
      passwordService.isBcryptHash.mockReturnValue(true);
      passwordService.verifyPassword.mockResolvedValue(true);

      const result = await service.validateUser('testbaker', 'password123');

      expect(result).toEqual(mockSettings);
      expect(passwordService.verifyPassword).toHaveBeenCalledWith(
        'password123',
        mockSettings.passHash,
      );
    });

    it('should validate and migrate legacy password', async () => {
      const legacySettings = {
        ...mockSettings,
        passHash: 'LEGACY_SHA512_HASH',
        hashSalt: 'salt123',
      } as SettingsEntity;

      settingsRepo.findAll.mockResolvedValue([legacySettings]);
      passwordService.isBcryptHash.mockReturnValue(false);
      passwordService.verifyLegacyHash.mockResolvedValue(true);
      passwordService.hashPassword.mockResolvedValue('$2b$12$newhash');

      const result = await service.validateUser('testbaker', 'password123');

      expect(result).toBeDefined();
      expect(passwordService.verifyLegacyHash).toHaveBeenCalledWith(
        'password123',
        legacySettings.passHash,
        legacySettings.hashSalt,
      );
      expect(settingsRepo.update).toHaveBeenCalledWith(
        legacySettings.bakerId,
        expect.objectContaining({
          passHash: '$2b$12$newhash',
        }),
      );
    });

    it('should return null for invalid password', async () => {
      settingsRepo.findAll.mockResolvedValue([mockSettings]);
      passwordService.isBcryptHash.mockReturnValue(true);
      passwordService.verifyPassword.mockResolvedValue(false);

      const result = await service.validateUser('testbaker', 'wrongpassword');

      expect(result).toBeNull();
    });

    it('should return null for non-existent user', async () => {
      settingsRepo.findAll.mockResolvedValue([]);

      const result = await service.validateUser('nonexistent', 'password123');

      expect(result).toBeNull();
    });
  });

  describe('login', () => {
    it('should login and return access token', async () => {
      settingsRepo.findAll.mockResolvedValue([mockSettings]);
      passwordService.isBcryptHash.mockReturnValue(true);
      passwordService.verifyPassword.mockResolvedValue(true);
      jwtService.generateToken.mockResolvedValue('jwt-token-123');
      jwtService.getTokenExpiration.mockReturnValue('24h');

      const result = await service.login({
        username: 'testbaker',
        password: 'password123',
      });

      expect(result).toEqual({
        access_token: 'jwt-token-123',
        token_type: 'Bearer',
        expires_in: '24h',
        user: {
          baker_id: mockSettings.bakerId,
          username: mockSettings.userName,
          operation_mode: mockSettings.mode,
        },
      });
      expect(jwtService.generateToken).toHaveBeenCalledWith({
        sub: mockSettings.bakerId,
        username: mockSettings.userName,
      });
    });

    it('should throw UnauthorizedException for invalid credentials', async () => {
      settingsRepo.findAll.mockResolvedValue([mockSettings]);
      passwordService.isBcryptHash.mockReturnValue(true);
      passwordService.verifyPassword.mockResolvedValue(false);

      await expect(
        service.login({
          username: 'testbaker',
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      settingsRepo.findByBakerId.mockResolvedValue(mockSettings);
      passwordService.isBcryptHash.mockReturnValue(true);
      passwordService.verifyPassword.mockResolvedValue(true);
      passwordService.validatePasswordStrength.mockReturnValue({
        valid: true,
        errors: [],
      });
      passwordService.hashPassword.mockResolvedValue('$2b$12$newhashedpassword');

      await service.changePassword('baker123', {
        currentPassword: 'oldpassword',
        newPassword: 'NewPassword123!',
      });

      expect(settingsRepo.update).toHaveBeenCalledWith('baker123', {
        passHash: '$2b$12$newhashedpassword',
      });
    });

    it('should throw error for incorrect current password', async () => {
      settingsRepo.findByBakerId.mockResolvedValue(mockSettings);
      passwordService.isBcryptHash.mockReturnValue(true);
      passwordService.verifyPassword.mockResolvedValue(false);

      await expect(
        service.changePassword('baker123', {
          currentPassword: 'wrongpassword',
          newPassword: 'NewPassword123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw error for weak new password', async () => {
      settingsRepo.findByBakerId.mockResolvedValue(mockSettings);
      passwordService.isBcryptHash.mockReturnValue(true);
      passwordService.verifyPassword.mockResolvedValue(true);
      passwordService.validatePasswordStrength.mockReturnValue({
        valid: false,
        errors: ['Password must be at least 8 characters long'],
      });

      await expect(
        service.changePassword('baker123', {
          currentPassword: 'oldpassword',
          newPassword: 'weak',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw error for non-existent user', async () => {
      settingsRepo.findByBakerId.mockResolvedValue(null);

      await expect(
        service.changePassword('nonexistent', {
          currentPassword: 'password',
          newPassword: 'NewPassword123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

});
