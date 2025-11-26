import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { SettingsRepository } from '../../../database/repositories';
import { CycleCheckJobData, BalancePollJobData } from '../interfaces/job-data.interface';

/**
 * Job Scheduler Service
 *
 * Manages recurring jobs and job scheduling
 */
@Injectable()
export class JobSchedulerService {
  private readonly logger = new Logger(JobSchedulerService.name);

  constructor(
    private readonly settingsRepo: SettingsRepository,
    @InjectQueue('cycle-monitoring')
    private readonly cycleMonitoringQueue: Queue<CycleCheckJobData>,
    @InjectQueue('blockchain-polling')
    private readonly blockchainPollingQueue: Queue<BalancePollJobData>,
  ) {}

  /**
   * Initialize all scheduled jobs for a baker
   */
  async initializeSchedules(bakerId: string): Promise<void> {
    this.logger.log(`Initializing job schedules for baker: ${bakerId}`);

    const settings = await this.settingsRepo.findByBakerId(bakerId);

    if (!settings) {
      throw new Error(`Settings not found for baker: ${bakerId}`);
    }

    // Cycle monitoring job
    // Runs every N minutes based on settings.update_freq
    const updateFreqMs = settings.updateFreq * 60 * 1000;

    await this.cycleMonitoringQueue.add(
      'check-cycle',
      { bakerId },
      {
        repeat: {
          every: updateFreqMs,
        },
        jobId: `cycle-monitor-${bakerId}`,
        removeOnComplete: {
          age: 3600, // Keep for 1 hour
          count: 10,
        },
        removeOnFail: {
          age: 86400, // Keep failed for 24 hours
        },
      },
    );

    this.logger.log(
      `Cycle monitoring scheduled every ${settings.updateFreq} minutes for baker: ${bakerId}`,
    );

    // Balance polling job (every 5 minutes)
    if (settings.hasWalletCredentials()) {
      await this.blockchainPollingQueue.add(
        'poll-balance',
        { bakerId },
        {
          repeat: {
            every: 5 * 60 * 1000, // 5 minutes
          },
          jobId: `balance-poll-${bakerId}`,
          removeOnComplete: {
            age: 1800, // Keep for 30 minutes
            count: 5,
          },
        },
      );

      this.logger.log(`Balance polling scheduled for baker: ${bakerId}`);
    }
  }

  /**
   * Update job schedule when settings change
   */
  async updateSchedule(bakerId: string): Promise<void> {
    this.logger.log(`Updating job schedules for baker: ${bakerId}`);

    // Remove existing jobs
    await this.removeSchedule(bakerId);

    // Re-initialize with new settings
    await this.initializeSchedules(bakerId);
  }

  /**
   * Remove all scheduled jobs for a baker
   */
  async removeSchedule(bakerId: string): Promise<void> {
    this.logger.log(`Removing job schedules for baker: ${bakerId}`);

    try {
      // Remove cycle monitoring job
      const cycleMonitorJob = await this.cycleMonitoringQueue.getRepeatableJobs();
      const cycleJob = cycleMonitorJob.find(
        (job) => job.id === `cycle-monitor-${bakerId}`,
      );

      if (cycleJob) {
        await this.cycleMonitoringQueue.removeRepeatableByKey(cycleJob.key);
        this.logger.debug(`Removed cycle monitoring job for baker: ${bakerId}`);
      }

      // Remove balance polling job
      const balanceJobs = await this.blockchainPollingQueue.getRepeatableJobs();
      const balanceJob = balanceJobs.find(
        (job) => job.id === `balance-poll-${bakerId}`,
      );

      if (balanceJob) {
        await this.blockchainPollingQueue.removeRepeatableByKey(balanceJob.key);
        this.logger.debug(`Removed balance polling job for baker: ${bakerId}`);
      }
    } catch (error) {
      this.logger.error(`Error removing schedules: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get status of all scheduled jobs for a baker
   */
  async getScheduleStatus(bakerId: string): Promise<{
    cycleMonitoring: any;
    balancePolling: any;
  }> {
    const cycleJobs = await this.cycleMonitoringQueue.getRepeatableJobs();
    const balanceJobs = await this.blockchainPollingQueue.getRepeatableJobs();

    const cycleJob = cycleJobs.find(
      (job) => job.id === `cycle-monitor-${bakerId}`,
    );
    const balanceJob = balanceJobs.find(
      (job) => job.id === `balance-poll-${bakerId}`,
    );

    return {
      cycleMonitoring: cycleJob || null,
      balancePolling: balanceJob || null,
    };
  }

  /**
   * Trigger manual cycle check
   */
  async triggerCycleCheck(bakerId: string): Promise<void> {
    this.logger.log(`Manually triggering cycle check for baker: ${bakerId}`);

    await this.cycleMonitoringQueue.add(
      'check-cycle',
      { bakerId },
      {
        priority: 1, // High priority for manual triggers
        removeOnComplete: true,
      },
    );
  }

  /**
   * Trigger manual balance poll
   */
  async triggerBalancePoll(bakerId: string): Promise<void> {
    this.logger.log(`Manually triggering balance poll for baker: ${bakerId}`);

    await this.blockchainPollingQueue.add(
      'poll-balance',
      { bakerId },
      {
        priority: 1,
        removeOnComplete: true,
      },
    );
  }
}
