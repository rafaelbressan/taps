import { DelegatorPayment as PrismaDelegatorPayment } from '@prisma/client';
import { DelegatorPaymentStatus, MUTEZ_PER_TEZ } from '../constants';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * DelegatorPayment entity with business logic
 * Represents a payment to a specific delegator for a cycle
 */
export class DelegatorPaymentEntity {
  id: number;
  bakerId: string;
  cycle: number;
  address: string;
  date: Date;
  result: DelegatorPaymentStatus;
  total: Decimal;
  transactionHash?: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: PrismaDelegatorPayment) {
    this.id = data.id;
    this.bakerId = data.bakerId;
    this.cycle = data.cycle;
    this.address = data.address;
    this.date = data.date;
    this.result = data.result as DelegatorPaymentStatus;
    this.total = data.total;
    this.transactionHash = data.transactionHash;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * Check if payment was applied successfully
   */
  isApplied(): boolean {
    return this.result === DelegatorPaymentStatus.APPLIED;
  }

  /**
   * Check if payment was simulated
   */
  isSimulated(): boolean {
    return this.result === DelegatorPaymentStatus.SIMULATED;
  }

  /**
   * Check if payment failed
   */
  isFailed(): boolean {
    return this.result === DelegatorPaymentStatus.FAILED;
  }

  /**
   * Check if payment is not available
   */
  isNotAvailable(): boolean {
    return this.result === DelegatorPaymentStatus.NOT_AVAILABLE;
  }

  /**
   * Check if payment is completed successfully
   */
  isCompleted(): boolean {
    return this.isApplied() || this.isSimulated();
  }

  /**
   * Check if payment can be retried
   */
  canRetry(): boolean {
    return this.isFailed() && !this.transactionHash;
  }

  /**
   * Get total amount in tez
   */
  getTotalTez(): number {
    return this.total.toNumber();
  }

  /**
   * Get total amount in mutez
   */
  getTotalMutez(): number {
    return Math.floor(this.total.toNumber() * MUTEZ_PER_TEZ);
  }

  /**
   * Calculate net payment after fee deduction
   * @param feePercentage Fee percentage (0-100)
   * @param grossAmount Gross amount before fee
   */
  static calculateNetPayment(
    grossAmount: number,
    feePercentage: number,
  ): number {
    if (feePercentage < 0 || feePercentage > 100) {
      throw new Error('Fee percentage must be between 0 and 100');
    }

    const feeDecimal = feePercentage / 100;
    return grossAmount * (1 - feeDecimal);
  }

  /**
   * Calculate fee amount from gross payment
   * @param grossAmount Gross amount before fee
   * @param feePercentage Fee percentage (0-100)
   */
  static calculateFeeAmount(
    grossAmount: number,
    feePercentage: number,
  ): number {
    if (feePercentage < 0 || feePercentage > 100) {
      throw new Error('Fee percentage must be between 0 and 100');
    }

    const feeDecimal = feePercentage / 100;
    return grossAmount * feeDecimal;
  }

  /**
   * Validate Tezos address format (basic validation)
   * Based on BUSINESS_LOGIC.md: addresses should be tz1, tz2, tz3, or KT1
   */
  static isValidTezosAddress(address: string): boolean {
    const prefixes = ['tz1', 'tz2', 'tz3', 'KT1'];
    return (
      prefixes.some((prefix) => address.startsWith(prefix)) &&
      address.length >= 36 &&
      address.length <= 50
    );
  }

  /**
   * Mark payment as applied
   */
  markAsApplied(transactionHash: string): void {
    this.result = DelegatorPaymentStatus.APPLIED;
    this.transactionHash = transactionHash;
  }

  /**
   * Mark payment as simulated
   */
  markAsSimulated(): void {
    this.result = DelegatorPaymentStatus.SIMULATED;
    this.transactionHash = null;
  }

  /**
   * Mark payment as failed
   */
  markAsFailed(errorMessage?: string): void {
    this.result = DelegatorPaymentStatus.FAILED;
    // Error message could be stored in a separate field if needed
  }

  /**
   * Mark payment as not available
   */
  markAsNotAvailable(): void {
    this.result = DelegatorPaymentStatus.NOT_AVAILABLE;
    this.transactionHash = null;
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON() {
    return {
      id: this.id,
      bakerId: this.bakerId,
      cycle: this.cycle,
      address: this.address,
      date: this.date.toISOString(),
      result: this.result,
      total: this.total.toNumber(),
      transactionHash: this.transactionHash,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
