import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { isValidTezosAddress } from '../../../config/tezos.config';
import { DelegatorReward } from './reward-calculator.service';
import { BondPoolDistributionResult } from '../../bond-pool/services/bond-pool.service';

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Reward Validator Service
 *
 * Validates reward calculations and distributions
 * Based on BUSINESS_LOGIC.md validation requirements
 *
 * Validation Rules:
 * - Minimum payment amount (avoid dust)
 * - Total distribution ≤ total rewards
 * - No negative amounts
 * - Valid Tezos addresses
 * - Fee percentages in range (0-100)
 * - Decimal precision (6 places)
 */
@Injectable()
export class RewardValidatorService {
  private readonly logger = new Logger(RewardValidatorService.name);
  private readonly MIN_PAYMENT_AMOUNT = new Decimal(0.000001); // 1 mutez
  private readonly MAX_DECIMAL_PLACES = 6;

  /**
   * Validate delegator rewards
   */
  validateDelegatorRewards(
    rewards: DelegatorReward[],
    totalRewards: Decimal,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check total doesn't exceed available rewards
    const totalDistributed = rewards.reduce(
      (sum, r) => sum.plus(r.netReward),
      new Decimal(0),
    );

    if (totalDistributed.greaterThan(totalRewards.plus(0.000001))) {
      errors.push(
        `Total distributed (${totalDistributed.toFixed(6)}) exceeds total rewards (${totalRewards.toFixed(6)})`,
      );
    }

    // Validate each reward
    for (const reward of rewards) {
      // Check address validity
      if (!isValidTezosAddress(reward.address)) {
        errors.push(`Invalid Tezos address: ${reward.address}`);
      }

      // Check for negative amounts
      if (reward.netReward.lessThan(0)) {
        errors.push(`Negative reward for ${reward.address}: ${reward.netReward.toString()}`);
      }

      // Check for dust (very small amounts)
      if (reward.netReward.greaterThan(0) && reward.netReward.lessThan(this.MIN_PAYMENT_AMOUNT)) {
        warnings.push(
          `Dust amount for ${reward.address}: ${reward.netReward.toFixed(6)} XTZ`,
        );
      }

      // Check decimal precision
      const decimalPlaces = (reward.netReward.toString().split('.')[1] || '').length;
      if (decimalPlaces > this.MAX_DECIMAL_PLACES) {
        errors.push(
          `Reward for ${reward.address} has too many decimal places: ${decimalPlaces}`,
        );
      }

      // Check fee percentage
      if (reward.fee.lessThan(0) || reward.fee.greaterThan(100)) {
        errors.push(
          `Invalid fee percentage for ${reward.address}: ${reward.fee.toString()}%`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate bond pool distribution
   */
  validateBondPoolDistribution(
    distribution: BondPoolDistributionResult,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check total doesn't exceed pool rewards
    if (
      distribution.totalDistributed.greaterThan(
        distribution.totalPoolRewards.plus(0.000001),
      )
    ) {
      errors.push(
        `Total distributed (${distribution.totalDistributed.toFixed(6)}) exceeds pool rewards (${distribution.totalPoolRewards.toFixed(6)})`,
      );
    }

    // Validate each member reward
    for (const reward of distribution.memberRewards) {
      // Check address validity
      if (!isValidTezosAddress(reward.address)) {
        errors.push(`Invalid Tezos address: ${reward.address}`);
      }

      // Check for negative amounts
      if (reward.netReward.lessThan(0)) {
        errors.push(`Negative reward for ${reward.address}: ${reward.netReward.toString()}`);
      }

      // Check decimal precision
      const decimalPlaces = (reward.netReward.toString().split('.')[1] || '').length;
      if (decimalPlaces > this.MAX_DECIMAL_PLACES) {
        errors.push(
          `Reward for ${reward.address} has too many decimal places: ${decimalPlaces}`,
        );
      }

      // Check stake is positive
      if (reward.stake.lessThanOrEqualTo(0)) {
        errors.push(`Invalid stake for ${reward.address}: ${reward.stake.toString()}`);
      }
    }

    // Check manager exists if admin fees exist
    if (distribution.totalAdminFees.greaterThan(0) && !distribution.managerAddress) {
      errors.push('Admin fees exist but no manager found');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Log validation result
   */
  logValidation(result: ValidationResult, context: string): void {
    if (result.valid) {
      this.logger.log(`✓ ${context} validation passed`);
    } else {
      this.logger.error(`✗ ${context} validation failed:`);
      for (const error of result.errors) {
        this.logger.error(`  - ${error}`);
      }
    }

    if (result.warnings.length > 0) {
      this.logger.warn(`⚠ ${context} warnings:`);
      for (const warning of result.warnings) {
        this.logger.warn(`  - ${warning}`);
      }
    }
  }
}
