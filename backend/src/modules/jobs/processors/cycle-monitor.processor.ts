import { Processor, Process, OnQueueActive, OnQueueCompleted } from '@nestjs/bull';
import { Logger, Injectable } from '@nestjs/common';
import { Job } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SettingsRepository, PaymentsRepository } from '../../../database/repositories';
import { TezosClientService } from '../../blockchain/services/tezos-client.service';
import { CycleDetectorService } from '../../rewards/services/cycle-detector.service';
import { CycleCheckJobData, CycleCheckResult, DistributeRewardsJobData } from '../interfaces/job-data.interface';

/**
 * Cycle Monitor Processor
 *
 * Monitors Tezos blockchain for cycle changes
 * Replaces ColdFusion scheduled task (script_fetch.cfm)
 *
 * Based on BUSINESS_LOGIC.md Section 3.1: "Automated Cycle Detection"
 */
@Injectable()
@Processor('cycle-monitoring')
export class CycleMonitorProcessor {
  private readonly logger = new Logger(CycleMonitorProcessor.name);

  constructor(
    private readonly settingsRepo: SettingsRepository,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly tezosClient: TezosClientService,
    private readonly cycleDetector: CycleDetectorService,
    @InjectQueue('reward-distribution')
    private readonly rewardDistributionQueue: Queue<DistributeRewardsJobData>,
  ) {}

  /**
   * Process cycle check job
   *
   * Runs periodically based on settings.update_freq
   * Detects cycle changes and triggers distribution if needed
   */
  @Process('check-cycle')
  async checkForCycleChange(job: Job<CycleCheckJobData>): Promise<CycleCheckResult> {
    const { bakerId } = job.data;

    this.logger.log(`Checking cycle for baker: ${bakerId}`);

    // Get settings
    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      this.logger.warn(`Settings not found for baker: ${bakerId}`);
      return {
        cycleChanged: false,
        previousCycle: 0,
        currentCycle: 0,
        rewardsAvailable: false,
      };
    }

    // Skip if mode is 'off'
    if (settings.mode === 'off') {
      this.logger.debug(`Skipping cycle check - mode is OFF for baker: ${bakerId}`);
      return {
        cycleChanged: false,
        previousCycle: 0,
        currentCycle: 0,
        rewardsAvailable: false,
      };
    }

    // Detect cycle change
    const cycleChange = await this.cycleDetector.detectCycleChange(bakerId);

    if (!cycleChange.changed) {
      this.logger.debug(
        `No cycle change detected. Current: ${cycleChange.currentCycle}, Previous: ${cycleChange.previousCycle}`,
      );
      return {
        cycleChanged: false,
        previousCycle: cycleChange.previousCycle || 0,
        currentCycle: cycleChange.currentCycle,
        rewardsAvailable: false,
      };
    }

    this.logger.log(
      `Cycle changed: ${cycleChange.previousCycle} → ${cycleChange.currentCycle}`,
    );

    // Check if rewards are available for previous cycle
    const rewardsAvailable = cycleChange.pendingRewardsCycle !== null;

    if (rewardsAvailable && cycleChange.pendingRewardsCycle) {
      this.logger.log(
        `Rewards available for cycle ${cycleChange.pendingRewardsCycle}. Triggering distribution...`,
      );

      // Trigger reward distribution job
      await this.rewardDistributionQueue.add(
        'distribute',
        {
          bakerId,
          cycle: cycleChange.pendingRewardsCycle,
          mode: settings.mode as 'off' | 'simulation' | 'on',
        },
        {
          attempts: settings.paymentRetries || 1,
          backoff: {
            type: 'exponential',
            delay: (settings.minutesBetweenRetries || 1) * 60 * 1000,
          },
          removeOnComplete: {
            age: 86400, // Keep completed jobs for 24 hours
            count: 100,
          },
        },
      );

      this.logger.log(
        `Distribution job queued for cycle ${cycleChange.pendingRewardsCycle}`,
      );
    }

    return {
      cycleChanged: true,
      previousCycle: cycleChange.previousCycle || 0,
      currentCycle: cycleChange.currentCycle,
      rewardsAvailable,
    };
  }

  @OnQueueActive()
  onActive(job: Job<CycleCheckJobData>) {
    this.logger.debug(
      `Processing cycle check job ${job.id} for baker ${job.data.bakerId}`,
    );
  }

  @OnQueueCompleted()
  onCompleted(job: Job<CycleCheckJobData>, result: CycleCheckResult) {
    this.logger.log(
      `Cycle check completed for baker ${job.data.bakerId}. Changed: ${result.cycleChanged}, Rewards available: ${result.rewardsAvailable}`,
    );
  }
}
