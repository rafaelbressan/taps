import {
  Processor,
  Process,
  OnQueueActive,
  OnQueueCompleted,
  OnQueueFailed,
} from '@nestjs/bull';
import { Logger, Injectable } from '@nestjs/common';
import { Job } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PaymentsRepository } from '../../../database/repositories';
import { DistributionOrchestratorService } from '../../rewards/services/distribution-orchestrator.service';
import {
  DistributeRewardsJobData,
  DistributionResult,
  BondPoolDistributionJobData,
} from '../interfaces/job-data.interface';

/**
 * Reward Distribution Processor
 *
 * Processes reward distribution for specific cycles
 * Can run in parallel for different cycles
 *
 * Based on BUSINESS_LOGIC.md reward distribution algorithm
 */
@Injectable()
@Processor('reward-distribution')
export class RewardDistributionProcessor {
  private readonly logger = new Logger(RewardDistributionProcessor.name);

  constructor(
    private readonly distributionOrchestrator: DistributionOrchestratorService,
    private readonly paymentsRepo: PaymentsRepository,
    @InjectQueue('bond-pool')
    private readonly bondPoolQueue: Queue<BondPoolDistributionJobData>,
  ) {}

  /**
   * Process reward distribution
   *
   * Distributes rewards to delegators for a specific cycle
   */
  @Process('distribute')
  async distributeRewards(
    job: Job<DistributeRewardsJobData>,
  ): Promise<DistributionResult> {
    const { bakerId, cycle, mode } = job.data;

    this.logger.log(
      `Starting distribution for cycle ${cycle} (${mode} mode) - Baker: ${bakerId}`,
    );

    try {
      // Execute full distribution workflow
      const result = await this.distributionOrchestrator.processRewardsDistribution(
        bakerId,
      );

      const distributionSuccess = result.delegatorDistribution.success;

      if (distributionSuccess) {
        this.logger.log(
          `Distribution successful for cycle ${result.delegatorDistribution.cycle}: ` +
            `${result.delegatorDistribution.delegatorsPaid} delegators paid, ` +
            `${result.delegatorDistribution.totalDistributed} XTZ distributed`,
        );
      } else {
        this.logger.warn(
          `Distribution completed with warnings for cycle ${result.delegatorDistribution.cycle}`,
        );
      }

      // If bond pool distribution occurred, trigger bond pool job
      if (result.bondPoolDistribution) {
        this.logger.log(`Queueing bond pool distribution for cycle ${cycle}`);

        await this.bondPoolQueue.add(
          'distribute-bond-pool',
          {
            bakerId,
            cycle: result.delegatorDistribution.cycle,
            totalRewards: result.cycleRewards.totalRewards,
            delegatorPayments: result.delegatorDistribution.totalDistributed,
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 60000, // 1 minute
            },
          },
        );
      }

      return {
        success: distributionSuccess,
        delegatorsPaid: result.delegatorDistribution.delegatorsPaid,
        totalDistributed: result.delegatorDistribution.totalDistributed,
        transactionHashes: result.delegatorDistribution.transactionHashes,
      };
    } catch (error) {
      this.logger.error(
        `Distribution failed for cycle ${cycle}: ${error.message}`,
        error.stack,
      );

      // Check if we should retry
      if (job.attemptsMade < (job.opts.attempts || 1)) {
        this.logger.log(
          `Will retry distribution (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`,
        );
        throw error; // Bull will retry
      }

      // Max retries reached - mark as failed
      this.logger.error(
        `Max retries reached for cycle ${cycle}. Marking as failed.`,
      );

      // Mark cycle as failed in database
      try {
        await this.paymentsRepo.updatePaymentStatus(
          bakerId,
          cycle,
          'failed',
          null,
          error.message,
        );
      } catch (dbError) {
        this.logger.error(
          `Failed to update payment status: ${dbError.message}`,
        );
      }

      return {
        success: false,
        delegatorsPaid: 0,
        totalDistributed: 0,
        transactionHashes: [],
        error: error.message,
      };
    }
  }

  @OnQueueActive()
  onActive(job: Job<DistributeRewardsJobData>) {
    this.logger.log(
      `Starting distribution job ${job.id} for cycle ${job.data.cycle} (attempt ${job.attemptsMade + 1})`,
    );
  }

  @OnQueueCompleted()
  onCompleted(job: Job<DistributeRewardsJobData>, result: DistributionResult) {
    if (result.success) {
      this.logger.log(
        `Distribution job ${job.id} completed successfully: ` +
          `${result.delegatorsPaid} delegators paid, ` +
          `${result.totalDistributed} XTZ distributed`,
      );
    } else {
      this.logger.warn(
        `Distribution job ${job.id} completed with errors: ${result.error}`,
      );
    }
  }

  @OnQueueFailed()
  async onFailed(job: Job<DistributeRewardsJobData>, error: Error) {
    this.logger.error(
      `Distribution job ${job.id} failed for cycle ${job.data.cycle}: ${error.message}`,
      error.stack,
    );

    // TODO: Send alert notification
    // await this.alertService.sendDistributionFailedAlert({
    //   cycle: job.data.cycle,
    //   bakerId: job.data.bakerId,
    //   error: error.message,
    //   attempts: job.attemptsMade,
    // });
  }
}
