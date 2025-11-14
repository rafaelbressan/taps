import {
  BondPoolSettings as PrismaBondPoolSettings,
  BondPoolMember as PrismaBondPoolMember,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * BondPoolSettings entity with business logic
 * Represents bond pool configuration for a baker
 */
export class BondPoolSettingsEntity {
  bakerId: string;
  status: boolean;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: PrismaBondPoolSettings) {
    this.bakerId = data.bakerId;
    this.status = data.status;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * Check if bond pool is enabled
   */
  isEnabled(): boolean {
    return this.status === true;
  }

  /**
   * Check if bond pool is disabled
   */
  isDisabled(): boolean {
    return this.status === false;
  }

  /**
   * Enable bond pool
   */
  enable(): void {
    this.status = true;
  }

  /**
   * Disable bond pool
   */
  disable(): void {
    this.status = false;
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON() {
    return {
      bakerId: this.bakerId,
      status: this.status,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}

/**
 * BondPoolMember entity with business logic
 * Represents a member of the bond pool with their contribution
 */
export class BondPoolMemberEntity {
  bakerId: string;
  address: string;
  amount: Decimal;
  name?: string | null;
  admCharge: Decimal;
  isManager: boolean;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: PrismaBondPoolMember) {
    this.bakerId = data.bakerId;
    this.address = data.address;
    this.amount = data.amount;
    this.name = data.name;
    this.admCharge = data.admCharge;
    this.isManager = data.isManager ?? false;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * Get member's contribution amount
   */
  getAmount(): number {
    return this.amount.toNumber();
  }

  /**
   * Get administrative charge amount
   */
  getAdmCharge(): number {
    return this.admCharge.toNumber();
  }

  /**
   * Check if member is a manager
   */
  isPoolManager(): boolean {
    return this.isManager === true;
  }

  /**
   * Calculate member's share percentage based on total pool
   */
  calculateSharePercentage(totalPoolAmount: number): number {
    if (totalPoolAmount <= 0) {
      return 0;
    }
    return (this.amount.toNumber() / totalPoolAmount) * 100;
  }

  /**
   * Calculate member's share of rewards
   * @param totalRewards Total rewards to distribute
   * @param totalPoolAmount Total amount in the pool
   */
  calculateRewardShare(
    totalRewards: number,
    totalPoolAmount: number,
  ): number {
    if (totalPoolAmount <= 0) {
      return 0;
    }

    const sharePercentage = this.calculateSharePercentage(totalPoolAmount);
    const baseReward = (totalRewards * sharePercentage) / 100;

    // Deduct administrative charge
    return baseReward - this.admCharge.toNumber();
  }

  /**
   * Validate member amount is positive
   */
  static isValidAmount(amount: number): boolean {
    return amount > 0;
  }

  /**
   * Validate administrative charge is non-negative
   */
  static isValidAdmCharge(charge: number): boolean {
    return charge >= 0;
  }

  /**
   * Update member's contribution amount
   */
  updateAmount(newAmount: number): void {
    if (!BondPoolMemberEntity.isValidAmount(newAmount)) {
      throw new Error('Amount must be positive');
    }
    this.amount = new Decimal(newAmount);
  }

  /**
   * Update administrative charge
   */
  updateAdmCharge(newCharge: number): void {
    if (!BondPoolMemberEntity.isValidAdmCharge(newCharge)) {
      throw new Error('Administrative charge cannot be negative');
    }
    this.admCharge = new Decimal(newCharge);
  }

  /**
   * Set manager status
   */
  setManagerStatus(isManager: boolean): void {
    this.isManager = isManager;
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON() {
    return {
      bakerId: this.bakerId,
      address: this.address,
      amount: this.amount.toNumber(),
      name: this.name,
      admCharge: this.admCharge.toNumber(),
      isManager: this.isManager,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
