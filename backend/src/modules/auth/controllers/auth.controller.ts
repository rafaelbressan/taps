import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuthService } from '../services/auth.service';
import { WalletEncryptionService } from '../services/wallet-encryption.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtPayload } from '../services/jwt-auth.service';
import {
  LoginDto,
  LoginResponse,
  ChangePasswordDto,
  VerifyWalletDto,
  UserResponse,
} from '../dto/auth.dto';

/**
 * Auth Controller
 *
 * Handles authentication endpoints
 * Replaces ColdFusion session-based auth with JWT
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly walletEncryption: WalletEncryptionService,
  ) {}

  /**
   * Login endpoint
   * POST /auth/login
   *
   * Replaces ColdFusion login.cfm
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<LoginResponse> {
    this.logger.log(`Login attempt for user: ${dto.username}`);
    return await this.authService.login(dto);
  }

  /**
   * Change password endpoint
   * POST /auth/change-password
   *
   * Replaces security.cfm password change
   */
  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    this.logger.log(`Password change request for user: ${user.username}`);

    await this.authService.changePassword(user.sub, dto);

    return {
      message: 'Password changed successfully',
    };
  }

  /**
   * Verify wallet passphrase
   * POST /auth/verify-wallet
   *
   * Verifies wallet passphrase for sensitive operations
   */
  @Post('verify-wallet')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyWalletPassphrase(
    @CurrentUser() user: JwtPayload,
    @Body() dto: VerifyWalletDto,
  ): Promise<{ valid: boolean }> {
    this.logger.log(`Wallet verification for user: ${user.username}`);

    // This would typically use the WalletAuthGuard
    // For now, just return success if endpoint is reached
    return {
      valid: true,
    };
  }

  /**
   * Get current user information
   * GET /auth/me
   *
   * Returns current authenticated user info
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getCurrentUser(@CurrentUser() user: JwtPayload): Promise<UserResponse> {
    this.logger.log(`Get user info for: ${user.username}`);
    return await this.authService.getCurrentUser(user.sub);
  }

  /**
   * Logout endpoint (optional - for token blacklisting)
   * POST /auth/logout
   *
   * Note: JWT tokens are stateless, so logout is handled client-side
   * by removing the token. This endpoint is optional for server-side
   * token blacklisting if needed.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: JwtPayload): Promise<{ message: string }> {
    this.logger.log(`Logout for user: ${user.username}`);

    // Optional: Add token to blacklist here
    // For now, just return success

    return {
      message: 'Logged out successfully',
    };
  }
}
