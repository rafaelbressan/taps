import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/**
 * Password Service
 *
 * Handles password hashing and verification
 * Upgrade from ColdFusion's SHA-512 to bcrypt
 *
 * Based on TECHNICAL_DEBT.md security improvements:
 * - Replace hash(password & salt, 'SHA-512') with bcrypt
 * - Support migration from legacy hashes
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly BCRYPT_ROUNDS = 12; // Work factor for bcrypt

  /**
   * Hash password with bcrypt (work factor: 12)
   * Replaces ColdFusion's hash(password & salt, 'SHA-512')
   *
   * @param password Plain text password
   * @returns Bcrypt hash (includes salt)
   */
  async hashPassword(password: string): Promise<string> {
    this.logger.debug('Hashing password with bcrypt');
    return await bcrypt.hash(password, this.BCRYPT_ROUNDS);
  }

  /**
   * Verify password against bcrypt hash
   *
   * @param password Plain text password
   * @param hash Bcrypt hash from database
   * @returns True if password matches
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(password, hash);
    } catch (error) {
      this.logger.error(`Password verification failed: ${error.message}`);
      return false;
    }
  }

  /**
   * MIGRATION HELPER: Verify legacy SHA-512 hash
   * Used during transition period to support existing users
   *
   * ColdFusion logic:
   * hash(password & salt, 'SHA-512')
   *
   * @param password Plain text password
   * @param oldHash Legacy SHA-512 hash from database
   * @param salt Salt used with legacy hash
   * @returns True if password matches legacy hash
   */
  async verifyLegacyHash(
    password: string,
    oldHash: string,
    salt: string,
  ): Promise<boolean> {
    try {
      this.logger.debug('Verifying legacy SHA-512 hash');

      // Recreate ColdFusion hash logic
      const combined = password + salt;
      const hash = crypto
        .createHash('sha512')
        .update(combined)
        .digest('hex')
        .toUpperCase();

      return hash === oldHash.toUpperCase();
    } catch (error) {
      this.logger.error(`Legacy hash verification failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if hash is bcrypt format
   * Bcrypt hashes start with $2a$, $2b$, or $2y$
   */
  isBcryptHash(hash: string): boolean {
    return /^\$2[ayb]\$\d{2}\$/.test(hash);
  }

  /**
   * Generate a random salt (for legacy compatibility)
   */
  generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Validate password strength
   * Requirements:
   * - At least 8 characters
   * - At least one uppercase letter
   * - At least one lowercase letter
   * - At least one number
   */
  validatePasswordStrength(password: string): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }

    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain at least one number');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check if password needs migration from legacy to bcrypt
   */
  needsMigration(hash: string): boolean {
    return !this.isBcryptHash(hash);
  }
}
