import { Payment as PrismaPayment } from '@prisma/client';
import { PaymentStatus, CYCLES_UNTIL_DELIVERED } from '../constants';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Payment entity with business logic
 * Represents a baker payment for a specific cycle
 */
export class PaymentEntity {
  id: number;
  bakerId: string;
  cycle: number;
  date: Date;
  result: PaymentStatus;
  total: Decimal;
  transactionHash?: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: PrismaPayment) {
    this.id = data.id;
    this.bakerId = data.bakerId;
    this.cycle = data.cycle;
    this.date = data.date;
    this.result = data.result as PaymentStatus;
    this.total = data.total;
    this.transactionHash = data.transactionHash;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * Check if payment is pending (rewards not yet available)
   */
  isPending(): boolean {
    return this.result === PaymentStatus.REWARDS_PENDING;
  }

  /**
   * Check if payment rewards are delivered
   */
  isRewardsDelivered(): boolean {
    return this.result === PaymentStatus.REWARDS_DELIVERED;
  }

  /**
   * Check if payment has been paid
   */
  isPaid(): boolean {
    return this.result === PaymentStatus.PAID;
  }

  /**
   * Check if payment was simulated
   */
  isSimulated(): boolean {
    return this.result === PaymentStatus.SIMULATED;
  }

  /**
   * Check if payment has errors
   */
  hasErrors(): boolean {
    return this.result === PaymentStatus.ERRORS;
  }

  /**
   * Check if payment is ready to be processed
   * Payments can be processed when rewards are delivered
   */
  isReadyForProcessing(): boolean {
    return this.isRewardsDelivered();
  }

  /**
   * Check if payment has been completed (paid or simulated)
   */
  isCompleted(): boolean {
    return this.isPaid() || this.isSimulated();
  }

  /**
   * Check if payment can be retried
   */
  canRetry(): boolean {
    return this.hasErrors() && !this.transactionHash;
  }

  /**
   * Get total amount in tez
   */
  getTotalTez(): number {
    return this.total.toNumber();
  }

  /**
   * Calculate the cycle when rewards will be delivered
   * Based on BUSINESS_LOGIC.md: rewards delivered after CYCLES_UNTIL_DELIVERED cycles
   */
  static calculateDeliveryCycle(currentCycle: number): number {
    return currentCycle + CYCLES_UNTIL_DELIVERED;
  }

  /**
   * Determine if a cycle's rewards are delivered based on current cycle
   */
  static areRewardsDelivered(paymentCycle: number, currentCycle: number): boolean {
    return currentCycle >= paymentCycle + CYCLES_UNTIL_DELIVERED;
  }

  /**
   * Get payment status based on cycle and current state
   */
  static determinePaymentStatus(
    paymentCycle: number,
    currentCycle: number,
    hasBeenPaid: boolean,
    isSimulation: boolean,
    hasError: boolean,
  ): PaymentStatus {
    if (hasError) {
      return PaymentStatus.ERRORS;
    }

    if (hasBeenPaid) {
      return isSimulation ? PaymentStatus.SIMULATED : PaymentStatus.PAID;
    }

    const rewardsDelivered = PaymentEntity.areRewardsDelivered(
      paymentCycle,
      currentCycle,
    );

    return rewardsDelivered
      ? PaymentStatus.REWARDS_DELIVERED
      : PaymentStatus.REWARDS_PENDING;
  }

  /**
   * Validate transaction hash format
   * Based on BUSINESS_LOGIC.md: hash length between 46-60 characters
   */
  static isValidTransactionHash(hash: string): boolean {
    return hash.length >= 46 && hash.length <= 60;
  }

  /**
   * Mark payment as paid
   */
  markAsPaid(transactionHash: string): void {
    if (!PaymentEntity.isValidTransactionHash(transactionHash)) {
      throw new Error('Invalid transaction hash format');
    }
    this.result = PaymentStatus.PAID;
    this.transactionHash = transactionHash;
  }

  /**
   * Mark payment as simulated
   */
  markAsSimulated(): void {
    this.result = PaymentStatus.SIMULATED;
    this.transactionHash = null;
  }

  /**
   * Mark payment as error
   */
  markAsError(): void {
    this.result = PaymentStatus.ERRORS;
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON() {
    return {
      id: this.id,
      bakerId: this.bakerId,
      cycle: this.cycle,
      date: this.date.toISOString(),
      result: this.result,
      total: this.total.toNumber(),
      transactionHash: this.transactionHash,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
