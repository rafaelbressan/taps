import { Controller, Get, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import axios from 'axios';

/**
 * Health Check Response
 */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptime: number;
  version: string;
  checks: {
    database: HealthCheck;
    redis?: HealthCheck;
    tezosRpc: HealthCheck;
    queues?: HealthCheck;
  };
}

export interface HealthCheck {
  status: 'ok' | 'error';
  message?: string;
  responseTime?: number;
}

/**
 * Health Controller
 *
 * Provides comprehensive health check endpoint
 */
@ApiTags('monitoring')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startTime: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.startTime = Date.now();
  }

  /**
   * Health check endpoint
   * GET /health
   */
  @Get()
  @ApiOperation({ summary: 'Comprehensive health check' })
  @ApiResponse({
    status: 200,
    description: 'Health check results',
  })
  async healthCheck(): Promise<HealthResponse> {
    const timeout =
      this.configService.get<number>('HEALTH_CHECK_TIMEOUT') || 5000;

    const checks = await Promise.all([
      this.checkDatabase(timeout),
      this.checkTezosRPC(timeout),
      // Redis and queues checks can be added here
    ]);

    const [database, tezosRpc] = checks;

    // Determine overall status
    let status: 'ok' | 'degraded' | 'error' = 'ok';

    if (database.status === 'error') {
      status = 'error'; // Database is critical
    } else if (tezosRpc.status === 'error') {
      status = 'degraded'; // Tezos RPC is important but not critical
    }

    const response: HealthResponse = {
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: this.configService.get<string>('VERSION', '2.0.0'),
      checks: {
        database,
        tezosRpc,
      },
    };

    if (status === 'error') {
      this.logger.error('Health check failed', response);
    } else if (status === 'degraded') {
      this.logger.warn('Health check degraded', response);
    }

    return response;
  }

  /**
   * Liveness probe - basic check
   * GET /health/live
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({
    status: 200,
    description: 'Service is alive',
  })
  async liveness(): Promise<{ status: string }> {
    return { status: 'ok' };
  }

  /**
   * Readiness probe - check if ready to serve traffic
   * GET /health/ready
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({
    status: 200,
    description: 'Service is ready',
  })
  @ApiResponse({
    status: 503,
    description: 'Service is not ready',
  })
  async readiness(): Promise<{ status: string }> {
    const database = await this.checkDatabase(2000);

    if (database.status === 'error') {
      throw new Error('Database not ready');
    }

    return { status: 'ok' };
  }

  /**
   * Check database connectivity
   */
  private async checkDatabase(timeout: number): Promise<HealthCheck> {
    const enabled = this.configService.get<boolean>(
      'HEALTH_CHECK_DATABASE',
      true,
    );

    if (!enabled) {
      return { status: 'ok', message: 'Database check disabled' };
    }

    const startTime = Date.now();

    try {
      // Use Promise.race to implement timeout
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeout),
        ),
      ]);

      const responseTime = Date.now() - startTime;

      return {
        status: 'ok',
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error('Database health check failed', error);

      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
      };
    }
  }

  /**
   * Check Tezos RPC connectivity
   */
  private async checkTezosRPC(timeout: number): Promise<HealthCheck> {
    const enabled = this.configService.get<boolean>(
      'HEALTH_CHECK_TEZOS_RPC',
      true,
    );

    if (!enabled) {
      return { status: 'ok', message: 'Tezos RPC check disabled' };
    }

    const rpcUrl = this.configService.get<string>('TEZOS_RPC_URL');

    if (!rpcUrl) {
      return {
        status: 'error',
        message: 'Tezos RPC URL not configured',
      };
    }

    const startTime = Date.now();

    try {
      // Check if RPC is responding
      await axios.get(`${rpcUrl}/chains/main/blocks/head/header`, {
        timeout,
      });

      const responseTime = Date.now() - startTime;

      return {
        status: 'ok',
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error('Tezos RPC health check failed', error);

      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
      };
    }
  }

  /**
   * Check Redis connectivity (optional)
   */
  private async checkRedis(timeout: number): Promise<HealthCheck> {
    const enabled = this.configService.get<boolean>('HEALTH_CHECK_REDIS', true);

    if (!enabled) {
      return { status: 'ok', message: 'Redis check disabled' };
    }

    // TODO: Implement Redis health check
    // This would require injecting a Redis client

    return {
      status: 'ok',
      message: 'Redis check not implemented',
    };
  }

  /**
   * Check queue status (optional)
   */
  private async checkQueues(timeout: number): Promise<HealthCheck> {
    // TODO: Implement queue health check
    // This would check Bull queue status

    return {
      status: 'ok',
      message: 'Queue check not implemented',
    };
  }
}
