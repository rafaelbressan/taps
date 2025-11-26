import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { PasswordService } from './services/password.service';
import { JwtAuthService } from './services/jwt-auth.service';
import { AuthService } from './services/auth.service';
import { WalletEncryptionService } from './services/wallet-encryption.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthController } from './controllers/auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { WalletAuthGuard } from './guards/wallet-auth.guard';

/**
 * Auth Module
 *
 * Provides JWT authentication and security services
 * Replaces ColdFusion session-based authentication
 */
@Module({
  imports: [
    DatabaseModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'your-secret-key-change-in-production',
        signOptions: {
          expiresIn: '24h',
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    PasswordService,
    JwtAuthService,
    AuthService,
    WalletEncryptionService,
    JwtStrategy,
    JwtAuthGuard,
    WalletAuthGuard,
  ],
  controllers: [AuthController],
  exports: [
    PasswordService,
    JwtAuthService,
    AuthService,
    WalletEncryptionService,
    JwtAuthGuard,
    WalletAuthGuard,
  ],
})
export class AuthModule {}
