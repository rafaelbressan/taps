import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { PasswordService } from './password.service';
import { JwtAuthService, JwtPayload } from './jwt-auth.service';
import { SettingsRepository } from '../../../database/repositories';
import { SettingsEntity } from '../../../shared/entities';
import {
  LoginDto,
  LoginResponse,
  ChangePasswordDto,
  UserResponse,
} from '../dto/auth.dto';

/**
 * Auth Service
 *
 * Main authentication logic
 * Based on BUSINESS_LOGIC.md: "User Authentication"
 *
 * Implements:
 * - Login with username/password
 * - Legacy password migration (SHA-512 → bcrypt)
 * - Password change
 * - User validation
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtAuthService,
    private readonly settingsRepo: SettingsRepository,
  ) {}

  /**
   * Login flow matching current system
   *
   * Steps:
   * 1. Validate username/password
   * 2. Check legacy hash if bcrypt fails (migration)
   * 3. Migrate to bcrypt if using legacy
   * 4. Generate JWT token
   * 5. Return token + user info
   *
   * Replaces ColdFusion session-based auth
   */
  async login(dto: LoginDto): Promise<LoginResponse> {
    this.logger.log(`Login attempt for user: ${dto.username}`);

    // Step 1: Find user by username
    const settings = await this.findUserByUsername(dto.username);

    if (!settings) {
      // Don't reveal if username exists
      throw new UnauthorizedException('Invalid credentials');
    }

    // Step 2: Validate password
    const user = await this.validateUser(dto.username, dto.password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Step 3: Generate JWT token
    const payload: JwtPayload = {
      sub: user.bakerId,
      username: user.userName || dto.username,
    };

    const token = await this.jwtService.generateToken(payload);

    this.logger.log(`Login successful for user: ${dto.username}`);

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.jwtService.getTokenExpiration(),
      user: {
        baker_id: user.bakerId,
        username: user.userName || dto.username,
        operation_mode: user.mode,
      },
    };
  }

  /**
   * Validate user credentials
   *
   * Implements password migration:
   * 1. Try bcrypt verification first
   * 2. If fails, try legacy SHA-512 verification
   * 3. If legacy succeeds, migrate to bcrypt
   *
   * Replaces: SELECT WHERE user_name = ? AND pass_hash = ?
   */
  async validateUser(
    username: string,
    password: string,
  ): Promise<SettingsEntity | null> {
    const settings = await this.findUserByUsername(username);

    if (!settings || !settings.passHash) {
      return null;
    }

    // Try bcrypt verification first
    if (this.passwordService.isBcryptHash(settings.passHash)) {
      const isValid = await this.passwordService.verifyPassword(
        password,
        settings.passHash,
      );

      if (isValid) {
        this.logger.debug(`User ${username} authenticated with bcrypt`);
        return settings;
      }

      return null;
    }

    // Legacy SHA-512 verification
    if (settings.hashSalt) {
      const isValid = await this.passwordService.verifyLegacyHash(
        password,
        settings.passHash,
        settings.hashSalt,
      );

      if (isValid) {
        this.logger.log(
          `User ${username} authenticated with legacy hash - migrating to bcrypt`,
        );

        // Migrate to bcrypt on successful login
        await this.migrateLegacyPassword(settings.bakerId, password);

        return settings;
      }
    }

    return null;
  }

  /**
   * Migrate user from SHA-512 to bcrypt on successful login
   */
  async migrateLegacyPassword(
    bakerId: string,
    password: string,
  ): Promise<void> {
    try {
      this.logger.log(`Migrating password to bcrypt for baker: ${bakerId}`);

      // Hash with bcrypt
      const newHash = await this.passwordService.hashPassword(password);

      // Update database
      await this.settingsRepo.update(bakerId, {
        passHash: newHash,
        // Keep salt for now (can be removed in future cleanup)
      });

      this.logger.log(`Password migration successful for baker: ${bakerId}`);
    } catch (error) {
      this.logger.error(`Password migration failed: ${error.message}`);
      // Don't fail login if migration fails
    }
  }

  /**
   * Change password
   * Replaces security.cfm logic
   */
  async changePassword(
    bakerId: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    this.logger.log(`Password change request for baker: ${bakerId}`);

    // Step 1: Get user settings
    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      throw new UnauthorizedException('User not found');
    }

    // Step 2: Verify current password
    const isCurrentValid = await this.verifyCurrentPassword(
      bakerId,
      dto.currentPassword,
    );

    if (!isCurrentValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Step 3: Validate new password strength
    const validation = this.passwordService.validatePasswordStrength(
      dto.newPassword,
    );

    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Password does not meet requirements',
        errors: validation.errors,
      });
    }

    // Step 4: Hash new password with bcrypt
    const newHash = await this.passwordService.hashPassword(dto.newPassword);

    // Step 5: Update database
    await this.settingsRepo.update(bakerId, {
      passHash: newHash,
    });

    this.logger.log(`Password changed successfully for baker: ${bakerId}`);
  }

  /**
   * Verify current password before sensitive operations
   */
  async verifyCurrentPassword(
    bakerId: string,
    password: string,
  ): Promise<boolean> {
    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings || !settings.passHash) {
      return false;
    }

    // Try bcrypt first
    if (this.passwordService.isBcryptHash(settings.passHash)) {
      return await this.passwordService.verifyPassword(
        password,
        settings.passHash,
      );
    }

    // Try legacy hash
    if (settings.hashSalt) {
      return await this.passwordService.verifyLegacyHash(
        password,
        settings.passHash,
        settings.hashSalt,
      );
    }

    return false;
  }

  /**
   * Get current user information
   */
  async getCurrentUser(bakerId: string): Promise<UserResponse> {
    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      throw new UnauthorizedException('User not found');
    }

    return {
      baker_id: settings.bakerId,
      username: settings.userName || '',
      operation_mode: settings.mode,
      has_wallet: settings.hasWalletCredentials(),
    };
  }

  /**
   * Find user by username
   */
  private async findUserByUsername(
    username: string,
  ): Promise<SettingsEntity | null> {
    // Get all settings and find by username
    const allSettings = await this.settingsRepo.findAll();

    const user = allSettings.find(
      (s) => s.userName?.toLowerCase() === username.toLowerCase(),
    );

    return user || null;
  }

  /**
   * Check if user exists
   */
  async userExists(username: string): Promise<boolean> {
    const user = await this.findUserByUsername(username);
    return user !== null;
  }
}
