import { Processor, Process } from '@nestjs/bull';
import { Logger, Injectable } from '@nestjs/common';
import { Job } from 'bull';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { SettingsRepository } from '../../../database/repositories';
import { TezosClientService } from '../../blockchain/services/tezos-client.service';
import { BalancePollJobData } from '../interfaces/job-data.interface';

/**
 * Blockchain Polling Processor
 *
 * Polls blockchain for balance updates and transaction confirmations
 * Runs more frequently than cycle monitoring
 */
@Injectable()
@Processor('blockchain-polling')
export class BlockchainPollProcessor {
  private readonly logger = new Logger(BlockchainPollProcessor.name);

  constructor(
    private readonly settingsRepo: SettingsRepository,
    private readonly tezosClient: TezosClientService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  /**
   * Poll baker balance
   *
   * Caches balance in Redis for quick access
   */
  @Process('poll-balance')
  async pollBalance(job: Job<BalancePollJobData>): Promise<number> {
    const { bakerId } = job.data;

    try {
      const settings = await this.settingsRepo.findByBakerId(bakerId);

      if (!settings || !settings.hasWalletCredentials()) {
        this.logger.debug(`Skipping balance poll - no wallet for baker: ${bakerId}`);
        return 0;
      }

      // Get current balance from blockchain
      const balance = await this.tezosClient.getBalance(bakerId);

      // Cache balance for 5 minutes
      await this.cacheManager.set(
        `balance:${bakerId}`,
        balance,
        300000, // 5 minutes in ms
      );

      this.logger.debug(`Balance polled for ${bakerId}: ${balance} XTZ`);

      return balance;
    } catch (error) {
      this.logger.error(
        `Failed to poll balance for ${bakerId}: ${error.message}`,
      );
      return 0;
    }
  }

  /**
   * Get cached balance
   */
  async getCachedBalance(bakerId: string): Promise<number | null> {
    try {
      const cached = await this.cacheManager.get<number>(`balance:${bakerId}`);
      return cached || null;
    } catch (error) {
      this.logger.error(`Failed to get cached balance: ${error.message}`);
      return null;
    }
  }
}
