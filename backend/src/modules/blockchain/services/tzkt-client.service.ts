import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { getTezosConfig } from '../../../config/tezos.config';
import Decimal from 'decimal.js';

/**
 * Baker rewards from TzKT API
 * Based on migration-docs/API_ENDPOINTS.md
 */
export interface BakerRewards {
  cycle: number;
  stakingBalance: number;
  delegatedBalance: number;
  numDelegators: number;
  expectedBlocks: number;
  expectedEndorsements: number;
  futureBlocks: number;
  futureBlockRewards: number;
  futureBlockFees: number;
  ownBlocks: number;
  ownBlockRewards: number;
  ownBlockFees: number;
  extraBlocks: number;
  extraBlockRewards: number;
  extraBlockFees: number;
  missedOwnBlocks: number;
  missedOwnBlockRewards: number;
  missedOwnBlockFees: number;
  missedExtraBlocks: number;
  missedExtraBlockRewards: number;
  missedExtraBlockFees: number;
  uncoveredOwnBlocks: number;
  uncoveredOwnBlockRewards: number;
  uncoveredOwnBlockFees: number;
  uncoveredExtraBlocks: number;
  uncoveredExtraBlockRewards: number;
  uncoveredExtraBlockFees: number;
  futureEndorsements: number;
  futureEndorsementRewards: number;
  endorsements: number;
  endorsementRewards: number;
  missedEndorsements: number;
  missedEndorsementRewards: number;
  uncoveredEndorsements: number;
  uncoveredEndorsementRewards: number;
  ownBlockFees: number;
  extraBlockFees: number;
  missedOwnBlockFees: number;
  missedExtraBlockFees: number;
  uncoveredOwnBlockFees: number;
  uncoveredExtraBlockFees: number;
  doubleBakingRewards: number;
  doubleBakingLostDeposits: number;
  doubleBakingLostRewards: number;
  doubleBakingLostFees: number;
  doubleEndorsingRewards: number;
  doubleEndorsingLostDeposits: number;
  doubleEndorsingLostRewards: number;
  doubleEndorsingLostFees: number;
  revelationRewards: number;
  revelationLostRewards: number;
  revelationLostFees: number;
}

/**
 * Delegator information
 */
export interface DelegatorInfo {
  address: string;
  balance: number;
  stakedBalance: number;
  type: string;
}

/**
 * Reward split for a cycle
 */
export interface RewardSplit {
  cycle: number;
  baker: string;
  stakingBalance: number;
  delegatedBalance: number;
  numDelegators: number;
  delegators: DelegatorReward[];
  bakerRewards: number;
  delegatorsRewards: number;
  totalRewards: number;
}

/**
 * Individual delegator reward
 */
export interface DelegatorReward {
  address: string;
  balance: number;
  share: number; // percentage
  reward: number;
}

/**
 * Cycle information
 */
export interface CycleInfo {
  index: number;
  firstLevel: number;
  startTime: Date;
  endTime: Date;
  snapshotLevel: number;
  randomSeed: string;
  totalBakers: number;
  totalDelegators: number;
  totalStaking: number;
}

/**
 * TzKT API client for querying Tezos blockchain data
 * Based on migration-docs/API_ENDPOINTS.md External APIs section
 */
@Injectable()
export class TzKTClientService {
  private readonly logger = new Logger(TzKTClientService.name);
  private readonly client: AxiosInstance;
  private readonly config = getTezosConfig();
  private readonly cache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 60000; // 1 minute

  constructor() {
    this.client = axios.create({
      baseURL: this.config.tzktApiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      response => {
        this.logger.debug(`TzKT API call successful: ${response.config.url}`);
        return response;
      },
      error => {
        this.logger.error(
          `TzKT API call failed: ${error.config?.url} - ${error.message}`,
        );
        return Promise.reject(error);
      },
    );
  }

  /**
   * Get from cache or fetch
   */
  private async getWithCache<T>(
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.debug(`Cache hit: ${key}`);
      return cached.data as T;
    }

    const data = await fetcher();
    this.cache.set(key, { data, timestamp: Date.now() });

    return data;
  }

  /**
   * Get baker rewards for a specific cycle
   */
  async getBakerRewards(
    bakerId: string,
    cycle: number,
  ): Promise<BakerRewards> {
    const cacheKey = `baker-rewards:${bakerId}:${cycle}`;

    return this.getWithCache(cacheKey, async () => {
      try {
        this.logger.log(
          `Fetching baker rewards for ${bakerId} cycle ${cycle}`,
        );

        const response = await this.client.get(
          `/v1/rewards/split/${bakerId}/${cycle}`,
        );

        // Transform TzKT response to our format
        const data = response.data;

        return {
          cycle: data.cycle || cycle,
          stakingBalance: data.stakingBalance || 0,
          delegatedBalance: data.delegatedBalance || 0,
          numDelegators: data.numDelegators || 0,
          expectedBlocks: data.expectedBlocks || 0,
          expectedEndorsements: data.expectedEndorsements || 0,
          futureBlocks: data.futureBlocks || 0,
          futureBlockRewards: data.futureBlockRewards || 0,
          futureBlockFees: data.futureBlockFees || 0,
          ownBlocks: data.ownBlocks || 0,
          ownBlockRewards: data.ownBlockRewards || 0,
          ownBlockFees: data.ownBlockFees || 0,
          extraBlocks: data.extraBlocks || 0,
          extraBlockRewards: data.extraBlockRewards || 0,
          extraBlockFees: data.extraBlockFees || 0,
          missedOwnBlocks: data.missedOwnBlocks || 0,
          missedOwnBlockRewards: data.missedOwnBlockRewards || 0,
          missedOwnBlockFees: data.missedOwnBlockFees || 0,
          missedExtraBlocks: data.missedExtraBlocks || 0,
          missedExtraBlockRewards: data.missedExtraBlockRewards || 0,
          missedExtraBlockFees: data.missedExtraBlockFees || 0,
          uncoveredOwnBlocks: data.uncoveredOwnBlocks || 0,
          uncoveredOwnBlockRewards: data.uncoveredOwnBlockRewards || 0,
          uncoveredOwnBlockFees: data.uncoveredOwnBlockFees || 0,
          uncoveredExtraBlocks: data.uncoveredExtraBlocks || 0,
          uncoveredExtraBlockRewards: data.uncoveredExtraBlockRewards || 0,
          uncoveredExtraBlockFees: data.uncoveredExtraBlockFees || 0,
          futureEndorsements: data.futureEndorsements || 0,
          futureEndorsementRewards: data.futureEndorsementRewards || 0,
          endorsements: data.endorsements || 0,
          endorsementRewards: data.endorsementRewards || 0,
          missedEndorsements: data.missedEndorsements || 0,
          missedEndorsementRewards: data.missedEndorsementRewards || 0,
          uncoveredEndorsements: data.uncoveredEndorsements || 0,
          uncoveredEndorsementRewards: data.uncoveredEndorsementRewards || 0,
          doubleBakingRewards: data.doubleBakingRewards || 0,
          doubleBakingLostDeposits: data.doubleBakingLostDeposits || 0,
          doubleBakingLostRewards: data.doubleBakingLostRewards || 0,
          doubleBakingLostFees: data.doubleBakingLostFees || 0,
          doubleEndorsingRewards: data.doubleEndorsingRewards || 0,
          doubleEndorsingLostDeposits: data.doubleEndorsingLostDeposits || 0,
          doubleEndorsingLostRewards: data.doubleEndorsingLostRewards || 0,
          doubleEndorsingLostFees: data.doubleEndorsingLostFees || 0,
          revelationRewards: data.revelationRewards || 0,
          revelationLostRewards: data.revelationLostRewards || 0,
          revelationLostFees: data.revelationLostFees || 0,
        };
      } catch (error) {
        this.logger.error(
          `Failed to fetch baker rewards: ${error.message}`,
        );
        throw new Error(`Failed to fetch baker rewards: ${error.message}`);
      }
    });
  }

  /**
   * Get reward split (baker + delegators)
   */
  async getRewardSplit(
    bakerId: string,
    cycle: number,
  ): Promise<RewardSplit> {
    const cacheKey = `reward-split:${bakerId}:${cycle}`;

    return this.getWithCache(cacheKey, async () => {
      try {
        this.logger.log(
          `Fetching reward split for ${bakerId} cycle ${cycle}`,
        );

        const response = await this.client.get(
          `/v1/rewards/split/${bakerId}/${cycle}`,
        );

        const data = response.data;

        // Calculate total rewards
        const totalRewards = new Decimal(data.ownBlockRewards || 0)
          .plus(data.extraBlockRewards || 0)
          .plus(data.endorsementRewards || 0)
          .plus(data.ownBlockFees || 0)
          .plus(data.extraBlockFees || 0)
          .plus(data.revelationRewards || 0)
          .minus(data.doubleBakingLostRewards || 0)
          .minus(data.doubleEndorsingLostRewards || 0)
          .toNumber();

        // Get delegator rewards
        const delegators: DelegatorReward[] = [];
        if (data.delegators && Array.isArray(data.delegators)) {
          for (const delegator of data.delegators) {
            delegators.push({
              address: delegator.address,
              balance: delegator.balance || 0,
              share: delegator.share || 0,
              reward: delegator.reward || 0,
            });
          }
        }

        const delegatorsRewards = delegators.reduce(
          (sum, d) => sum + d.reward,
          0,
        );

        const bakerRewards = totalRewards - delegatorsRewards;

        return {
          cycle,
          baker: bakerId,
          stakingBalance: data.stakingBalance || 0,
          delegatedBalance: data.delegatedBalance || 0,
          numDelegators: data.numDelegators || delegators.length,
          delegators,
          bakerRewards,
          delegatorsRewards,
          totalRewards,
        };
      } catch (error) {
        this.logger.error(
          `Failed to fetch reward split: ${error.message}`,
        );
        throw new Error(`Failed to fetch reward split: ${error.message}`);
      }
    });
  }

  /**
   * Get delegators for a baker
   */
  async getDelegators(bakerId: string): Promise<DelegatorInfo[]> {
    const cacheKey = `delegators:${bakerId}`;

    return this.getWithCache(cacheKey, async () => {
      try {
        this.logger.log(`Fetching delegators for ${bakerId}`);

        const response = await this.client.get(
          `/v1/delegates/${bakerId}/delegators`,
        );

        const delegators: DelegatorInfo[] = [];

        if (Array.isArray(response.data)) {
          for (const delegator of response.data) {
            delegators.push({
              address: delegator.address,
              balance: delegator.balance || 0,
              stakedBalance: delegator.stakedBalance || 0,
              type: delegator.type || 'user',
            });
          }
        }

        this.logger.log(`Found ${delegators.length} delegators for ${bakerId}`);

        return delegators;
      } catch (error) {
        this.logger.error(
          `Failed to fetch delegators: ${error.message}`,
        );
        throw new Error(`Failed to fetch delegators: ${error.message}`);
      }
    });
  }

  /**
   * Get cycle information
   */
  async getCycleInfo(cycle: number): Promise<CycleInfo> {
    const cacheKey = `cycle:${cycle}`;

    return this.getWithCache(cacheKey, async () => {
      try {
        this.logger.log(`Fetching cycle ${cycle} information`);

        const response = await this.client.get(`/v1/cycles/${cycle}`);

        const data = response.data;

        return {
          index: data.index || cycle,
          firstLevel: data.firstLevel || 0,
          startTime: new Date(data.startTime),
          endTime: new Date(data.endTime),
          snapshotLevel: data.snapshotLevel || 0,
          randomSeed: data.randomSeed || '',
          totalBakers: data.totalBakers || 0,
          totalDelegators: data.totalDelegators || 0,
          totalStaking: data.totalStaking || 0,
        };
      } catch (error) {
        this.logger.error(
          `Failed to fetch cycle info: ${error.message}`,
        );
        throw new Error(`Failed to fetch cycle info: ${error.message}`);
      }
    });
  }

  /**
   * Get account balance
   */
  async getAccountBalance(address: string): Promise<number> {
    const cacheKey = `balance:${address}`;

    return this.getWithCache(cacheKey, async () => {
      try {
        this.logger.log(`Fetching balance for ${address}`);

        const response = await this.client.get(`/v1/accounts/${address}`);

        return response.data.balance || 0;
      } catch (error) {
        this.logger.error(
          `Failed to fetch account balance: ${error.message}`,
        );
        throw new Error(`Failed to fetch account balance: ${error.message}`);
      }
    });
  }

  /**
   * Get operation status
   */
  async getOperation(opHash: string): Promise<any> {
    try {
      this.logger.log(`Fetching operation ${opHash}`);

      const response = await this.client.get(
        `/v1/operations/transactions/${opHash}`,
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Failed to fetch operation: ${error.message}`);
      return null;
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.log('Cache cleared');
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
