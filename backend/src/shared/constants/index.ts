/**
 * Tezos Constants
 * Based on migration-docs/BUSINESS_LOGIC.md
 */

export const MUTEZ_PER_TEZ = 1_000_000;

export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_MINUTE = 60;

export const TX_HASH_MIN_LENGTH = 46;
export const TX_HASH_MAX_LENGTH = 60;

export const CYCLES_UNTIL_DELIVERED = 5;

/**
 * Payment Status Enums
 */
export enum PaymentStatus {
  REWARDS_PENDING = 'rewards_pending',
  REWARDS_DELIVERED = 'rewards_delivered',
  PAID = 'paid',
  SIMULATED = 'simulated',
  ERRORS = 'errors',
}

/**
 * Delegator Payment Status Enums
 */
export enum DelegatorPaymentStatus {
  APPLIED = 'applied',
  SIMULATED = 'simulated',
  FAILED = 'failed',
  NOT_AVAILABLE = 'not available',
}

/**
 * Operation Modes
 */
export enum OperationMode {
  OFF = 'off',
  SIMULATION = 'simulation',
  ON = 'on',
}

/**
 * Cycle Status
 */
export enum CycleStatus {
  CYCLE_PENDING = 'cycle_pending',
  CYCLE_IN_PROGRESS = 'cycle_in_progress',
  REWARDS_PENDING = 'rewards_pending',
  REWARDS_DELIVERED = 'rewards_delivered',
}
