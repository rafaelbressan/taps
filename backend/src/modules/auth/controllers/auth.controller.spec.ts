import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from '../services/auth.service';
import { WalletEncryptionService } from '../services/wallet-encryption.service';
import { JwtPayload } from '../services/jwt-auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<AuthService>;

  const mockUser: JwtPayload = {
    sub: 'baker123',
    username: 'testbaker',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            login: jest.fn(),
            changePassword: jest.fn(),
            getCurrentUser: jest.fn(),
          },
        },
        {
          provide: WalletEncryptionService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get(AuthService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('login', () => {
    it('should login successfully', async () => {
      const loginDto = {
        username: 'testbaker',
        password: 'Password123!',
      };

      const loginResult = {
        access_token: 'jwt-token-123',
        token_type: 'Bearer',
        expires_in: '24h',
        user: {
          baker_id: 'baker123',
          username: 'testbaker',
          operation_mode: 'simulation',
        },
      };

      authService.login.mockResolvedValue(loginResult);

      const result = await controller.login(loginDto);

      expect(result).toEqual(loginResult);
      expect(authService.login).toHaveBeenCalledWith(loginDto);
    });

    it('should throw UnauthorizedException for invalid credentials', async () => {
      const loginDto = {
        username: 'testbaker',
        password: 'wrongpassword',
      };

      authService.login.mockRejectedValue(
        new UnauthorizedException('Invalid credentials'),
      );

      await expect(controller.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      const changePasswordDto = {
        currentPassword: 'OldPassword123!',
        newPassword: 'NewPassword123!',
      };

      authService.changePassword.mockResolvedValue(undefined);

      const result = await controller.changePassword(
        mockUser,
        changePasswordDto,
      );

      expect(result).toEqual({ message: 'Password changed successfully' });
      expect(authService.changePassword).toHaveBeenCalledWith(
        mockUser.sub,
        changePasswordDto,
      );
    });

    it('should throw error for incorrect current password', async () => {
      const changePasswordDto = {
        currentPassword: 'wrongpassword',
        newPassword: 'NewPassword123!',
      };

      authService.changePassword.mockRejectedValue(
        new UnauthorizedException('Current password is incorrect'),
      );

      await expect(
        controller.changePassword(mockUser, changePasswordDto),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw error for weak new password', async () => {
      const changePasswordDto = {
        currentPassword: 'OldPassword123!',
        newPassword: 'weak',
      };

      authService.changePassword.mockRejectedValue(
        new BadRequestException('Password does not meet strength requirements'),
      );

      await expect(
        controller.changePassword(mockUser, changePasswordDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user from JWT', async () => {
      authService.getCurrentUser.mockResolvedValue({
        baker_id: mockUser.sub,
        username: mockUser.username,
        operation_mode: 'simulation',
        has_wallet: true,
      });

      const result = await controller.getCurrentUser(mockUser);

      expect(result).toEqual({
        baker_id: mockUser.sub,
        username: mockUser.username,
        operation_mode: 'simulation',
        has_wallet: true,
      });
    });
  });

  describe('verifyWalletPassphrase', () => {
    it('should verify wallet passphrase successfully', async () => {
      const verifyDto = {
        passphrase: 'wallet-passphrase-123',
      };

      const result = await controller.verifyWalletPassphrase(mockUser, verifyDto);

      expect(result).toEqual({ valid: true });
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      const result = await controller.logout(mockUser);

      expect(result).toEqual({
        message: 'Logged out successfully',
      });
    });
  });
});
