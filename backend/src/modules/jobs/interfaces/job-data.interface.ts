/**
 * Job Data Interfaces
 */

/**
 * Cycle monitoring job data
 */
export interface CycleCheckJobData {
  bakerId: string;
}

/**
 * Reward distribution job data
 */
export interface DistributeRewardsJobData {
  bakerId: string;
  cycle: number;
  mode: 'off' | 'simulation' | 'on';
}

/**
 * Balance polling job data
 */
export interface BalancePollJobData {
  bakerId: string;
}

/**
 * Transaction confirmation job data
 */
export interface ConfirmationCheckJobData {
  opHash: string;
  bakerId: string;
  cycle: number;
}

/**
 * Bond pool distribution job data
 */
export interface BondPoolDistributionJobData {
  bakerId: string;
  cycle: number;
  totalRewards: number;
  delegatorPayments: number;
}

/**
 * Job result interfaces
 */
export interface CycleCheckResult {
  cycleChanged: boolean;
  previousCycle: number;
  currentCycle: number;
  rewardsAvailable: boolean;
}

export interface DistributionResult {
  success: boolean;
  delegatorsPaid: number;
  totalDistributed: number;
  transactionHashes: string[];
  error?: string;
}
