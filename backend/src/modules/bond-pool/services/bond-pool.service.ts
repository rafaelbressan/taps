import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BondPoolRepository } from '../../../database/repositories';
import { BondPoolMemberEntity } from '../../../shared/entities';
import { BatchTransfer } from '../../blockchain/services/transaction.service';
import { TEZOS_CONSTANTS } from '../../../config/tezos.config';

/**
 * Bond pool member reward calculation
 */
export interface BondPoolMemberReward {
  address: string;
  stake: Decimal; // Member's stake amount
  stakePercentage: Decimal; // Percentage of total pool
  rewardBeforeFee: Decimal; // Reward before admin charge (tez)
  adminCharge: Decimal; // Admin charge amount (tez)
  netReward: Decimal; // Final payment to member (tez)
  netRewardMutez: number; // Final payment in mutez
  isManager: boolean;
}

/**
 * Bond pool distribution result
 */
export interface BondPoolDistributionResult {
  cycle: number;
  totalPoolRewards: Decimal; // Total rewards available for pool (tez)
  totalPoolStake: Decimal; // Total stake in pool
  memberRewards: BondPoolMemberReward[];
  managerAddress: string | null;
  totalAdminFees: Decimal; // Sum of all admin charges (tez)
  managerTotalReward: Decimal; // Manager's share + admin fees (tez)
  totalDistributed: Decimal; // Total distributed to all members (tez)
}

/**
 * Bond Pool Service
 *
 * Calculates and distributes bond pool rewards to pool members
 * Based on BUSINESS_LOGIC.md Section 2: "Bond Pool Distribution Logic"
 *
 * Formula from BUSINESS_LOGIC.md Section 2.2:
 * pool_rewards = total_cycle_rewards - total_delegator_payments
 * member_share = (member.amount / total_pool_stake) * pool_rewards
 * admin_fee = member_share * member.adm_charge / 100
 * member_payment = member_share - admin_fee
 * manager_gets_all_admin_fees
 */
@Injectable()
export class BondPoolService {
  private readonly logger = new Logger(BondPoolService.name);

  constructor(private readonly bondPoolRepo: BondPoolRepository) {
    // Configure Decimal.js precision
    Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });
  }

  /**
   * Calculate and distribute bond pool rewards
   * Based on BUSINESS_LOGIC.md Section 2.2
   *
   * @param params Calculation parameters
   * @returns Distribution result with all member rewards
   */
  async calculateBondPoolRewards(params: {
    bakerId: string;
    cycle: number;
    totalCycleRewards: Decimal; // Total rewards for the cycle (tez)
    totalDelegatorPayments: Decimal; // Amount paid to delegators (tez)
  }): Promise<BondPoolDistributionResult> {
    this.logger.log(
      `Calculating bond pool rewards for baker ${params.bakerId} cycle ${params.cycle}`,
    );

    // Step 1: Check if bond pool is enabled
    const bondPoolSettings = await this.bondPoolRepo.findSettingsByBakerId(
      params.bakerId,
    );

    if (!bondPoolSettings || !bondPoolSettings.isEnabled()) {
      this.logger.log('Bond pool is not enabled');
      return this.getEmptyResult(params.cycle);
    }

    // Step 2: Calculate pool rewards (what's left after delegator payments)
    const totalPoolRewards = params.totalCycleRewards.minus(
      params.totalDelegatorPayments,
    );

    this.logger.log(
      `Total pool rewards: ${totalPoolRewards.toFixed(6)} XTZ (${params.totalCycleRewards.toFixed(6)} - ${params.totalDelegatorPayments.toFixed(6)})`,
    );

    if (totalPoolRewards.lessThanOrEqualTo(0)) {
      this.logger.warn('No rewards available for bond pool');
      return this.getEmptyResult(params.cycle);
    }

    // Step 3: Get all bond pool members
    const members = await this.bondPoolRepo.findMembersByBakerId(
      params.bakerId,
    );

    if (members.length === 0) {
      this.logger.warn('No bond pool members found');
      return this.getEmptyResult(params.cycle);
    }

    // Step 4: Calculate total bond pool stake
    const totalStake = await this.bondPoolRepo.getTotalPoolAmount(
      params.bakerId,
    );

    const totalStakeDecimal = new Decimal(totalStake);

    this.logger.log(
      `Total pool stake: ${totalStakeDecimal.toFixed(2)} XTZ, Members: ${members.length}`,
    );

    // Step 5: Calculate rewards for each member
    const memberRewards: BondPoolMemberReward[] = [];
    let totalAdminFees = new Decimal(0);
    let managerAddress: string | null = null;

    for (const member of members) {
      const reward = this.calculateMemberReward(
        member,
        totalStakeDecimal,
        totalPoolRewards,
      );

      memberRewards.push(reward);
      totalAdminFees = totalAdminFees.plus(reward.adminCharge);

      if (reward.isManager) {
        managerAddress = reward.address;
      }

      this.logger.debug(
        `${member.address}: Stake ${reward.stake.toFixed(2)} (${reward.stakePercentage.toFixed(2)}%), ` +
          `Reward ${reward.netReward.toFixed(6)} XTZ, Admin fee ${reward.adminCharge.toFixed(6)} XTZ`,
      );
    }

    // Step 6: Calculate manager's total (their share + all admin fees)
    let managerTotalReward = new Decimal(0);
    if (managerAddress) {
      const managerReward = memberRewards.find(
        (r) => r.address === managerAddress,
      );
      if (managerReward) {
        // Manager gets their net reward + total admin fees
        managerTotalReward = managerReward.netReward.plus(totalAdminFees);
      }
    }

    // Step 7: Calculate total distributed
    const totalMemberPayments = memberRewards.reduce(
      (sum, r) => sum.plus(r.netReward),
      new Decimal(0),
    );
    const totalDistributed = totalMemberPayments.plus(totalAdminFees);

    this.logger.log(
      `Total distributed: ${totalDistributed.toFixed(6)} XTZ, ` +
        `Admin fees: ${totalAdminFees.toFixed(6)} XTZ, ` +
        `Manager total: ${managerTotalReward.toFixed(6)} XTZ`,
    );

    return {
      cycle: params.cycle,
      totalPoolRewards,
      totalPoolStake: totalStakeDecimal,
      memberRewards,
      managerAddress,
      totalAdminFees,
      managerTotalReward,
      totalDistributed,
    };
  }

  /**
   * Calculate reward for a single bond pool member
   * Based on BUSINESS_LOGIC.md Section 2.2
   *
   * Formula:
   * member_share_percent = (member.amount / total_bond) * 100
   * member_rewards_before = (pool_rewards * member_share_percent) / 100
   * admin_fee = member_rewards_before * (member.adm_charge / 100)
   * member_payment = member_rewards_before - admin_fee
   */
  private calculateMemberReward(
    member: BondPoolMemberEntity,
    totalStake: Decimal,
    totalPoolRewards: Decimal,
  ): BondPoolMemberReward {
    const memberStake = new Decimal(member.getAmount());

    // Step 1: Calculate member's share percentage
    const stakePercentage = memberStake.div(totalStake).times(100);

    // Step 2: Calculate member's rewards before fee
    const rewardBeforeFee = totalPoolRewards
      .times(stakePercentage)
      .div(100);

    // Step 3: Calculate administrative charge
    const admChargePercent = new Decimal(member.getAdmCharge());
    const adminCharge = rewardBeforeFee.times(admChargePercent).div(100);

    // Step 4: Calculate net payment to member
    const netReward = rewardBeforeFee.minus(adminCharge);

    // Round to 6 decimal places
    const netRewardRounded = new Decimal(netReward.toFixed(6));

    // Convert to mutez
    const netRewardMutez = netRewardRounded
      .times(TEZOS_CONSTANTS.MUTEZ_PER_TEZ)
      .toNumber();

    return {
      address: member.address,
      stake: memberStake,
      stakePercentage,
      rewardBeforeFee,
      adminCharge,
      netReward: netRewardRounded,
      netRewardMutez: Math.floor(netRewardMutez),
      isManager: member.isPoolManager(),
    };
  }

  /**
   * Get pool manager (is_manager = true)
   */
  async getPoolManager(
    bakerId: string,
  ): Promise<BondPoolMemberEntity | null> {
    const managers = await this.bondPoolRepo.findManagersByBakerId(bakerId);

    if (managers.length === 0) {
      this.logger.warn(`No pool manager found for baker ${bakerId}`);
      return null;
    }

    if (managers.length > 1) {
      this.logger.warn(
        `Multiple pool managers found for baker ${bakerId}, using first one`,
      );
    }

    return managers[0];
  }

  /**
   * Build batch transaction for bond pool distribution
   * Creates transfers for:
   * 1. Each member's net reward
   * 2. Admin fees to manager (single transaction)
   */
  async buildBondPoolBatchTransfers(
    result: BondPoolDistributionResult,
  ): Promise<BatchTransfer[]> {
    const transfers: BatchTransfer[] = [];

    // Step 1: Add transfers for each member's net reward
    for (const reward of result.memberRewards) {
      if (reward.netRewardMutez > 0) {
        transfers.push({
          to: reward.address,
          amount: reward.netRewardMutez,
        });
      }
    }

    // Step 2: Add admin fees to manager (if exists and fees > 0)
    if (result.managerAddress && result.totalAdminFees.greaterThan(0)) {
      const adminFeesMutez = result.totalAdminFees
        .times(TEZOS_CONSTANTS.MUTEZ_PER_TEZ)
        .toNumber();

      transfers.push({
        to: result.managerAddress,
        amount: Math.floor(adminFeesMutez),
      });

      this.logger.log(
        `Added admin fees transfer: ${result.totalAdminFees.toFixed(6)} XTZ to ${result.managerAddress}`,
      );
    }

    this.logger.log(
      `Built ${transfers.length} bond pool transfers (${result.memberRewards.length} members + ${result.totalAdminFees.greaterThan(0) ? 1 : 0} admin fee)`,
    );

    return transfers;
  }

  /**
   * Validate bond pool distribution
   */
  validateDistribution(result: BondPoolDistributionResult): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check total doesn't exceed pool rewards
    if (
      result.totalDistributed.greaterThan(
        result.totalPoolRewards.plus(0.000001),
      )
    ) {
      errors.push(
        `Distributed amount (${result.totalDistributed.toFixed(6)}) exceeds pool rewards (${result.totalPoolRewards.toFixed(6)})`,
      );
    }

    // Check no negative amounts
    for (const reward of result.memberRewards) {
      if (reward.netReward.lessThan(0)) {
        errors.push(`Negative reward for member ${reward.address}`);
      }
    }

    // Check manager exists if there are admin fees
    if (
      result.totalAdminFees.greaterThan(0) &&
      !result.managerAddress
    ) {
      errors.push('Admin fees exist but no manager found');
    }

    // Check precision (6 decimal places)
    for (const reward of result.memberRewards) {
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
   * Get empty result (when bond pool disabled or no rewards)
   */
  private getEmptyResult(cycle: number): BondPoolDistributionResult {
    return {
      cycle,
      totalPoolRewards: new Decimal(0),
      totalPoolStake: new Decimal(0),
      memberRewards: [],
      managerAddress: null,
      totalAdminFees: new Decimal(0),
      managerTotalReward: new Decimal(0),
      totalDistributed: new Decimal(0),
    };
  }

  /**
   * Get distribution summary
   */
  getSummary(result: BondPoolDistributionResult): {
    cycle: number;
    totalPoolRewards: string;
    memberCount: number;
    totalDistributed: string;
    totalAdminFees: string;
    managerTotalReward: string;
  } {
    return {
      cycle: result.cycle,
      totalPoolRewards: result.totalPoolRewards.toFixed(6),
      memberCount: result.memberRewards.length,
      totalDistributed: result.totalDistributed.toFixed(6),
      totalAdminFees: result.totalAdminFees.toFixed(6),
      managerTotalReward: result.managerTotalReward.toFixed(6),
    };
  }
}
