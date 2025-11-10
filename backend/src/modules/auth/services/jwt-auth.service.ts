import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getTezosConfig } from '../../../config/tezos.config';

/**
 * JWT payload interface
 */
export interface JwtPayload {
  sub: string; // baker_id
  username: string;
  iat?: number; // issued at
  exp?: number; // expiration
}

/**
 * JWT Auth Service
 *
 * Handles JWT token generation and verification
 * Replaces session-based authentication from ColdFusion
 */
@Injectable()
export class JwtAuthService {
  private readonly logger = new Logger(JwtAuthService.name);
  private readonly JWT_EXPIRATION = '24h'; // Token expires after 24 hours
  private readonly REFRESH_TOKEN_EXPIRATION = '7d'; // Refresh token expires after 7 days

  constructor(private readonly jwtService: JwtService) {}

  /**
   * Generate JWT access token with user payload
   * Replaces session-based auth
   *
   * @param payload User information to encode in token
   * @returns Signed JWT token
   */
  async generateToken(payload: JwtPayload): Promise<string> {
    this.logger.debug(`Generating JWT token for user: ${payload.username}`);

    const token = await this.jwtService.signAsync(
      {
        sub: payload.sub,
        username: payload.username,
      },
      {
        expiresIn: this.JWT_EXPIRATION,
      },
    );

    this.logger.log(`JWT token generated for user: ${payload.username}`);
    return token;
  }

  /**
   * Verify and decode JWT token
   *
   * @param token JWT token to verify
   * @returns Decoded payload
   * @throws UnauthorizedException if token is invalid
   */
  async verifyToken(token: string): Promise<JwtPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      return payload;
    } catch (error) {
      this.logger.error(`JWT verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Generate refresh token
   * Optional: for implementing token refresh flow
   *
   * @param userId Baker ID
   * @returns Signed refresh token
   */
  async generateRefreshToken(userId: string): Promise<string> {
    this.logger.debug(`Generating refresh token for user: ${userId}`);

    const token = await this.jwtService.signAsync(
      {
        sub: userId,
        type: 'refresh',
      },
      {
        expiresIn: this.REFRESH_TOKEN_EXPIRATION,
      },
    );

    return token;
  }

  /**
   * Decode token without verification (for debugging)
   * DO NOT use for authentication
   */
  decodeToken(token: string): JwtPayload | null {
    try {
      return this.jwtService.decode(token) as JwtPayload;
    } catch (error) {
      this.logger.error(`Token decode failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get token expiration time
   */
  getTokenExpiration(): string {
    return this.JWT_EXPIRATION;
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(payload: JwtPayload): boolean {
    if (!payload.exp) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    return payload.exp < now;
  }
}
