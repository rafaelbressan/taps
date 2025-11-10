import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { SettingsModule } from './modules/settings/settings.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { HealthController } from './health.controller';
import { RATE_LIMIT_CONFIG } from './config/security.config';

@Module({
  imports: [
    // Core modules
    ConfigModule,
    DatabaseModule,

    // Rate limiting (global protection against brute force)
    ThrottlerModule.forRoot([
      {
        ttl: RATE_LIMIT_CONFIG.ttl,
        limit: RATE_LIMIT_CONFIG.limit,
      },
    ]),

    // Feature modules
    AuthModule,
    SettingsModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Apply rate limiting globally
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
