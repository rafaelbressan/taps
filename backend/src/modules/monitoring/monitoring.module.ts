import { Module, Global } from '@nestjs/common';
import { SentryService } from './services/sentry.service';
import { MetricsService } from './services/metrics.service';
import { MetricsController } from './controllers/metrics.controller';
import { HealthController } from './controllers/health.controller';

/**
 * Monitoring Module
 *
 * Provides monitoring, metrics, and health check functionality
 */
@Global()
@Module({
  controllers: [MetricsController, HealthController],
  providers: [SentryService, MetricsService],
  exports: [SentryService, MetricsService],
})
export class MonitoringModule {}
