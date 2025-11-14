import { DelegatorFee as PrismaDelegatorFee } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * DelegatorFee entity with business logic
 * Represents a custom fee for a specific delegator
 */
export class DelegatorFeeEntity {
  bakerId: string;
  address: string;
  fee: Decimal;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: PrismaDelegatorFee) {
    this.bakerId = data.bakerId;
    this.address = data.address;
    this.fee = data.fee;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * Get fee as a percentage (0-100)
   */
  getFeePercentage(): number {
    return this.fee.toNumber();
  }

  /**
   * Get fee as a decimal (0-1)
   */
  getFeeDecimal(): number {
    return this.fee.toNumber() / 100;
  }

  /**
   * Validate fee percentage
   */
  static isValidFee(fee: number): boolean {
    return fee >= 0 && fee <= 100;
  }

  /**
   * Calculate payment amount after fee deduction
   */
  calculateNetPayment(grossAmount: number): number {
    const feeDecimal = this.getFeeDecimal();
    return grossAmount * (1 - feeDecimal);
  }

  /**
   * Calculate fee amount
   */
  calculateFeeAmount(grossAmount: number): number {
    const feeDecimal = this.getFeeDecimal();
    return grossAmount * feeDecimal;
  }

  /**
   * Check if fee is different from default
   */
  isDifferentFromDefault(defaultFee: number): boolean {
    return this.fee.toNumber() !== defaultFee;
  }

  /**
   * Check if fee is zero (no fee)
   */
  isZeroFee(): boolean {
    return this.fee.toNumber() === 0;
  }

  /**
   * Check if fee is maximum (100%)
   */
  isMaximumFee(): boolean {
    return this.fee.toNumber() === 100;
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON() {
    return {
      bakerId: this.bakerId,
      address: this.address,
      fee: this.fee.toNumber(),
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
