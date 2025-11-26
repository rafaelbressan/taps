import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MetricsService } from '../services/metrics.service';

/**
 * Metrics Controller
 *
 * Exposes Prometheus metrics endpoint
 */
@ApiTags('monitoring')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  /**
   * Get Prometheus metrics
   * GET /metrics
   */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Get Prometheus metrics' })
  @ApiResponse({
    status: 200,
    description: 'Metrics in Prometheus format',
    type: String,
  })
  async getMetrics(): Promise<string> {
    return await this.metricsService.getMetrics();
  }
}
