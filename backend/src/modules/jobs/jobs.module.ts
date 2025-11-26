import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { CacheModule } from '@nestjs/cache-manager';
import { DatabaseModule } from '../../database/database.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { RewardsModule } from '../rewards/rewards.module';
import { JobsController } from './controllers/jobs.controller';
import { JobSchedulerService } from './services/job-scheduler.service';
import { CycleMonitorProcessor } from './processors/cycle-monitor.processor';
import { RewardDistributionProcessor } from './processors/reward-distribution.processor';
import { BlockchainPollProcessor } from './processors/blockchain-poll.processor';

@Module({
  imports: [
    // Configure Bull queues
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
      defaultJobOptions: {
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 100,
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours
        },
      },
    }),

    // Register queues
    BullModule.registerQueue(
      { name: 'cycle-monitoring' },
      { name: 'reward-distribution' },
      { name: 'blockchain-polling' },
      { name: 'bond-pool' },
    ),

    // Cache module for Redis caching
    CacheModule.register({
      ttl: 300, // 5 minutes default TTL
      max: 100, // Maximum number of items in cache
    }),

    // Feature modules
    DatabaseModule,
    BlockchainModule,
    RewardsModule,
  ],
  controllers: [JobsController],
  providers: [
    JobSchedulerService,
    CycleMonitorProcessor,
    RewardDistributionProcessor,
    BlockchainPollProcessor,
  ],
  exports: [JobSchedulerService, BullModule],
})
export class JobsModule {}
