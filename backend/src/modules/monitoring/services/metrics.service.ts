import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as promClient from 'prom-client';

/**
 * Metrics Service
 *
 * Provides Prometheus metrics for monitoring
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);
  private readonly register: promClient.Registry;

  // HTTP metrics
  private readonly httpRequestDuration: promClient.Histogram;
  private readonly httpRequestTotal: promClient.Counter;
  private readonly httpRequestErrors: promClient.Counter;

  // Business metrics
  private readonly rewardDistributionTotal: promClient.Counter;
  private readonly rewardDistributionAmount: promClient.Gauge;
  private readonly activeDeleg ators: promClient.Gauge;
  private readonly cycleProcessingDuration: promClient.Histogram;

  // System metrics
  private readonly databaseConnectionPool: promClient.Gauge;
  private readonly redisConnections: promClient.Gauge;
  private readonly jobQueueSize: promClient.Gauge;
  private readonly jobProcessingDuration: promClient.Histogram;

  // Tezos metrics
  private readonly tezosRpcRequestDuration: promClient.Histogram;
  private readonly tezosRpcErrors: promClient.Counter;
  private readonly bakerBalance: promClient.Gauge;

  constructor(private readonly configService: ConfigService) {
    // Create a new registry
    this.register = new promClient.Registry();

    // Add default labels
    this.register.setDefaultLabels({
      app: 'taps-backend',
      env: this.configService.get<string>('NODE_ENV', 'development'),
    });

    // Initialize HTTP metrics
    this.httpRequestDuration = new promClient.Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [this.register],
    });

    this.httpRequestTotal = new promClient.Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register],
    });

    this.httpRequestErrors = new promClient.Counter({
      name: 'http_request_errors_total',
      help: 'Total number of HTTP request errors',
      labelNames: ['method', 'route', 'error_type'],
      registers: [this.register],
    });

    // Initialize business metrics
    this.rewardDistributionTotal = new promClient.Counter({
      name: 'reward_distributions_total',
      help: 'Total number of reward distributions',
      labelNames: ['baker_id', 'status'],
      registers: [this.register],
    });

    this.rewardDistributionAmount = new promClient.Gauge({
      name: 'reward_distribution_amount_xtz',
      help: 'Amount of rewards distributed in XTZ',
      labelNames: ['baker_id', 'cycle'],
      registers: [this.register],
    });

    this.activeDelegators = new promClient.Gauge({
      name: 'active_delegators_count',
      help: 'Number of active delegators',
      labelNames: ['baker_id'],
      registers: [this.register],
    });

    this.cycleProcessingDuration = new promClient.Histogram({
      name: 'cycle_processing_duration_seconds',
      help: 'Duration of cycle processing in seconds',
      labelNames: ['baker_id', 'cycle'],
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.register],
    });

    // Initialize system metrics
    this.databaseConnectionPool = new promClient.Gauge({
      name: 'database_connection_pool_size',
      help: 'Number of database connections in the pool',
      labelNames: ['state'],
      registers: [this.register],
    });

    this.redisConnections = new promClient.Gauge({
      name: 'redis_connections_count',
      help: 'Number of Redis connections',
      labelNames: ['state'],
      registers: [this.register],
    });

    this.jobQueueSize = new promClient.Gauge({
      name: 'job_queue_size',
      help: 'Number of jobs in queue',
      labelNames: ['queue_name', 'state'],
      registers: [this.register],
    });

    this.jobProcessingDuration = new promClient.Histogram({
      name: 'job_processing_duration_seconds',
      help: 'Duration of job processing in seconds',
      labelNames: ['job_name', 'status'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
      registers: [this.register],
    });

    // Initialize Tezos metrics
    this.tezosRpcRequestDuration = new promClient.Histogram({
      name: 'tezos_rpc_request_duration_seconds',
      help: 'Duration of Tezos RPC requests in seconds',
      labelNames: ['method', 'endpoint'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [this.register],
    });

    this.tezosRpcErrors = new promClient.Counter({
      name: 'tezos_rpc_errors_total',
      help: 'Total number of Tezos RPC errors',
      labelNames: ['method', 'error_type'],
      registers: [this.register],
    });

    this.bakerBalance = new promClient.Gauge({
      name: 'baker_balance_xtz',
      help: 'Baker balance in XTZ',
      labelNames: ['baker_id'],
      registers: [this.register],
    });
  }

  onModuleInit() {
    // Collect default metrics (CPU, memory, etc.)
    const enabled = this.configService.get<boolean>('ENABLE_METRICS', true);

    if (enabled) {
      promClient.collectDefaultMetrics({ register: this.register });
      this.logger.log('Metrics collection initialized');
    } else {
      this.logger.log('Metrics collection disabled');
    }
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return await this.register.metrics();
  }

  /**
   * Get registry
   */
  getRegister(): promClient.Registry {
    return this.register;
  }

  // HTTP Metrics
  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    duration: number,
  ): void {
    this.httpRequestDuration.observe(
      { method, route, status_code: statusCode },
      duration / 1000,
    );
    this.httpRequestTotal.inc({ method, route, status_code: statusCode });
  }

  recordHttpError(method: string, route: string, errorType: string): void {
    this.httpRequestErrors.inc({ method, route, error_type: errorType });
  }

  // Business Metrics
  recordRewardDistribution(
    bakerId: string,
    status: 'success' | 'failed',
  ): void {
    this.rewardDistributionTotal.inc({ baker_id: bakerId, status });
  }

  setRewardDistributionAmount(
    bakerId: string,
    cycle: number,
    amount: number,
  ): void {
    this.rewardDistributionAmount.set(
      { baker_id: bakerId, cycle: cycle.toString() },
      amount,
    );
  }

  setActiveDelegators(bakerId: string, count: number): void {
    this.activeDelegators.set({ baker_id: bakerId }, count);
  }

  recordCycleProcessing(
    bakerId: string,
    cycle: number,
    duration: number,
  ): void {
    this.cycleProcessingDuration.observe(
      { baker_id: bakerId, cycle: cycle.toString() },
      duration / 1000,
    );
  }

  // System Metrics
  setDatabaseConnectionPool(active: number, idle: number): void {
    this.databaseConnectionPool.set({ state: 'active' }, active);
    this.databaseConnectionPool.set({ state: 'idle' }, idle);
  }

  setRedisConnections(active: number): void {
    this.redisConnections.set({ state: 'active' }, active);
  }

  setJobQueueSize(queueName: string, waiting: number, active: number): void {
    this.jobQueueSize.set({ queue_name: queueName, state: 'waiting' }, waiting);
    this.jobQueueSize.set({ queue_name: queueName, state: 'active' }, active);
  }

  recordJobProcessing(
    jobName: string,
    status: 'success' | 'failed',
    duration: number,
  ): void {
    this.jobProcessingDuration.observe(
      { job_name: jobName, status },
      duration / 1000,
    );
  }

  // Tezos Metrics
  recordTezosRpcRequest(
    method: string,
    endpoint: string,
    duration: number,
  ): void {
    this.tezosRpcRequestDuration.observe(
      { method, endpoint },
      duration / 1000,
    );
  }

  recordTezosRpcError(method: string, errorType: string): void {
    this.tezosRpcErrors.inc({ method, error_type: errorType });
  }

  setBakerBalance(bakerId: string, balance: number): void {
    this.bakerBalance.set({ baker_id: bakerId }, balance);
  }
}
