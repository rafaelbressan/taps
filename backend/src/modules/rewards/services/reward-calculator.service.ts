import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { TzKTClientService, RewardSplit } from '../../blockchain/services/tzkt-client.service';
import { SettingsRepository, DelegatorsFeeRepository } from '../../../database/repositories';
import { TEZOS_CONSTANTS } from '../../../config/tezos.config';

/**
 * Delegator share before fee application
 */
export interface DelegatorShare {
  address: string;
  balance: number; // mutez
  share: number; // percentage (0-100)
  rewardBeforeFee: number; // tez
}

/**
 * Delegator reward after fee application
 */
export interface DelegatorReward {
  address: string;
  grossReward: Decimal; // Before fee (tez)
  fee: Decimal; // Fee percentage (0-100)
  netReward: Decimal; // After fee (tez)
  netRewardMutez: number; // After fee (mutez)
}

/**
 * Cycle rewards calculation result
 */
export interface CycleRewardsResult {
  cycle: number;
  totalRewards: Decimal; // Total cycle rewards (tez)
  delegatorRewards: DelegatorReward[];
  totalDelegatorPayments: Decimal; // Sum of all net rewards (tez)
  bakerShare: Decimal; // Rewards not distributed to delegators (tez)
}

/**
 * Reward Calculator Service
 *
 * Implements reward calculation formulas from BUSINESS_LOGIC.md
 * All calculations use Decimal.js for precision (6 decimal places)
 *
 * Formula from BUSINESS_LOGIC.md:
 * paymentValue = ((rewards / MUTEZ_PER_TEZ) * ((100 - fee) / 100) * 100) / 100
 *
 * Simplified:
 * paymentValue = (rewards / MUTEZ_PER_TEZ) * ((100 - fee) / 100)
 */
@Injectable()
export class RewardCalculatorService {
  private readonly logger = new Logger(RewardCalculatorService.name);

  constructor(
    private readonly tzktClient: TzKTClientService,
    private readonly settingsRepo: SettingsRepository,
    private readonly delegatorsFeeRepo: DelegatorsFeeRepository,
  ) {
    // Configure Decimal.js precision (6 decimal places for Tezos)
    Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });
  }

  /**
   * Calculate rewards for all delegators in a cycle
   * Based on BUSINESS_LOGIC.md Section 1.1 & 1.2
   */
  async calculateCycleRewards(params: {
    bakerId: string;
    cycle: number;
  }): Promise<CycleRewardsResult> {
    this.logger.log(
      `Calculating cycle rewards for baker ${params.bakerId} cycle ${params.cycle}`,
    );

    // Step 1: Get reward split from TzKT API
    const rewardSplit = await this.tzktClient.getRewardSplit(
      params.bakerId,
      params.cycle,
    );

    this.logger.log(
      `Total rewards: ${rewardSplit.totalRewards} mutez, Delegators: ${rewardSplit.delegators.length}`,
    );

    // Step 2: Get default fee from settings
    const settings = await this.settingsRepo.findByBakerId(params.bakerId);
    if (!settings) {
      throw new Error(`Settings not found for baker ${params.bakerId}`);
    }

    const defaultFee = settings.getDefaultFeeDecimal() * 100; // Convert to percentage

    // Step 3: Calculate rewards for each delegator
    const delegatorRewards: DelegatorReward[] = [];
    let totalPayments = new Decimal(0);

    for (const delegator of rewardSplit.delegators) {
      // Apply custom fee or default
      const reward = await this.calculateDelegatorReward(
        delegator.address,
        delegator.reward, // in mutez
        defaultFee,
        params.bakerId,
      );

      delegatorRewards.push(reward);
      totalPayments = totalPayments.plus(reward.netReward);

      this.logger.debug(
        `${delegator.address}: ${reward.netReward.toFixed(6)} XTZ (fee: ${reward.fee}%)`,
      );
    }

    // Step 4: Calculate baker's share (rewards not distributed to delegators)
    const totalRewardsTez = new Decimal(rewardSplit.totalRewards).div(
      TEZOS_CONSTANTS.MUTEZ_PER_TEZ,
    );

    const bakerShare = totalRewardsTez.minus(totalPayments);

    this.logger.log(
      `Total delegator payments: ${totalPayments.toFixed(6)} XTZ, Baker share: ${bakerShare.toFixed(6)} XTZ`,
    );

    return {
      cycle: params.cycle,
      totalRewards: totalRewardsTez,
      delegatorRewards,
      totalDelegatorPayments: totalPayments,
      bakerShare,
    };
  }

  /**
   * Calculate payment for a single delegator
   * Implements formula from BUSINESS_LOGIC.md Section 1.2
   *
   * Formula:
   * paymentValue = ((rewards / MUTEZ_PER_TEZ) * ((100 - fee) / 100) * 100) / 100
   *
   * @param address Delegator address
   * @param rewardsMutez Gross reward in mutez
   * @param defaultFee Default fee percentage
   * @param bakerId Baker ID for custom fee lookup
   */
  private async calculateDelegatorReward(
    address: string,
    rewardsMutez: number,
    defaultFee: number,
    bakerId: string,
  ): Promise<DelegatorReward> {
    // Step 1: Get custom fee or use default (BUSINESS_LOGIC.md Section 1.3)
    const fee = await this.delegatorsFeeRepo.getFeeForDelegator(
      bakerId,
      address,
      defaultFee,
    );

    // Step 2: Convert mutez to tez
    const rewardsTez = new Decimal(rewardsMutez).div(
      TEZOS_CONSTANTS.MUTEZ_PER_TEZ,
    );

    // Step 3: Calculate net payment
    // paymentValue = ((rewards / MUTEZ_PER_TEZ) * ((100 - fee) / 100) * 100) / 100
    const keepPercentage = new Decimal(100).minus(fee).div(100);
    const netReward = rewardsTez.times(keepPercentage);

    // Step 4: Round to 6 decimal places
    const netRewardRounded = new Decimal(netReward.toFixed(6));

    // Step 5: Convert back to mutez for transaction
    const netRewardMutez = netRewardRounded
      .times(TEZOS_CONSTANTS.MUTEZ_PER_TEZ)
      .toNumber();

    return {
      address,
      grossReward: rewardsTez,
      fee: new Decimal(fee),
      netReward: netRewardRounded,
      netRewardMutez: Math.floor(netRewardMutez),
    };
  }

  /**
   * Apply custom fees from delegatorsFee table
   * Falls back to default_fee from settings
   * Based on BUSINESS_LOGIC.md Section 1.3
   */
  async applyFees(
    delegators: DelegatorShare[],
    bakerId: string,
  ): Promise<DelegatorReward[]> {
    this.logger.log(`Applying fees for ${delegators.length} delegators`);

    const settings = await this.settingsRepo.findByBakerId(bakerId);
    if (!settings) {
      throw new Error(`Settings not found for baker ${bakerId}`);
    }

    const defaultFee = settings.getDefaultFeeDecimal() * 100;

    const rewards: DelegatorReward[] = [];

    for (const delegator of delegators) {
      // Get custom fee or use default
      const fee = await this.delegatorsFeeRepo.getFeeForDelegator(
        bakerId,
        delegator.address,
        defaultFee,
      );

      // Calculate net reward
      const grossReward = new Decimal(delegator.rewardBeforeFee);
      const keepPercentage = new Decimal(100).minus(fee).div(100);
      const netReward = grossReward.times(keepPercentage);
      const netRewardRounded = new Decimal(netReward.toFixed(6));

      const netRewardMutez = netRewardRounded
        .times(TEZOS_CONSTANTS.MUTEZ_PER_TEZ)
        .toNumber();

      rewards.push({
        address: delegator.address,
        grossReward,
        fee: new Decimal(fee),
        netReward: netRewardRounded,
        netRewardMutez: Math.floor(netRewardMutez),
      });
    }

    return rewards;
  }

  /**
   * Validate calculation results
   */
  validateCalculation(result: CycleRewardsResult): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check total doesn't exceed rewards
    const distributed = result.totalDelegatorPayments.plus(result.bakerShare);
    if (distributed.greaterThan(result.totalRewards.plus(0.000001))) {
      // Allow tiny rounding error
      errors.push(
        `Distributed amount (${distributed.toFixed(6)}) exceeds total rewards (${result.totalRewards.toFixed(6)})`,
      );
    }

    // Check no negative amounts
    for (const reward of result.delegatorRewards) {
      if (reward.netReward.lessThan(0)) {
        errors.push(`Negative reward for ${reward.address}`);
      }
    }

    // Check precision (6 decimal places)
    for (const reward of result.delegatorRewards) {
      const decimalPlaces = (reward.netReward.toString().split('.')[1] || '')
        .length;
      if (decimalPlaces > 6) {
        errors.push(
          `Reward for ${reward.address} has too many decimal places: ${decimalPlaces}`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Calculate total fees collected
   */
  calculateTotalFees(rewards: DelegatorReward[]): Decimal {
    let totalFees = new Decimal(0);

    for (const reward of rewards) {
      const fee = reward.grossReward.minus(reward.netReward);
      totalFees = totalFees.plus(fee);
    }

    return totalFees;
  }

  /**
   * Get summary statistics
   */
  getSummary(result: CycleRewardsResult): {
    totalRewards: string;
    totalDelegatorPayments: string;
    totalFees: string;
    bakerShare: string;
    delegatorCount: number;
    averageReward: string;
  } {
    const totalFees = this.calculateTotalFees(result.delegatorRewards);
    const averageReward =
      result.delegatorRewards.length > 0
        ? result.totalDelegatorPayments.div(result.delegatorRewards.length)
        : new Decimal(0);

    return {
      totalRewards: result.totalRewards.toFixed(6),
      totalDelegatorPayments: result.totalDelegatorPayments.toFixed(6),
      totalFees: totalFees.toFixed(6),
      bakerShare: result.bakerShare.toFixed(6),
      delegatorCount: result.delegatorRewards.length,
      averageReward: averageReward.toFixed(6),
    };
  }
}
