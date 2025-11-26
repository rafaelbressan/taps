import { Injectable, Logger } from '@nestjs/common';
import { InMemorySigner } from '@taquito/signer';
import Decimal from 'decimal.js';
import {
  TransactionService,
  BatchTransfer,
  BatchResult,
} from '../../blockchain/services/transaction.service';
import { WalletService } from '../../wallet/services/wallet.service';
import {
  SettingsRepository,
  PaymentsRepository,
  DelegatorsPaymentsRepository,
} from '../../../database/repositories';
import { RewardCalculatorService, DelegatorReward } from './reward-calculator.service';
import { OperationMode, PaymentStatus, DelegatorPaymentStatus } from '../../../shared/constants';
import { TEZOS_CONSTANTS } from '../../../config/tezos.config';

/**
 * Distribution parameters
 */
export interface DistributionParams {
  bakerId: string;
  cycle: number;
  mode: OperationMode; // 'off', 'simulation', or 'on'
}

/**
 * Distribution result
 */
export interface DistributionResult {
  success: boolean;
  cycle: number;
  mode: OperationMode;
  totalDelegators: number;
  totalAmount: Decimal; // in tez
  transactionHash?: string;
  applied: boolean;
  errors: string[];
  retriesUsed: number;
}

/**
 * Payment Distributor Service
 *
 * Orchestrates the automated payment distribution to delegators
 * Based on BUSINESS_LOGIC.md Section 1: "Reward Distribution Logic"
 *
 * Main Flow (from BUSINESS_LOGIC.md Section 1.1):
 * 1. Calculate delegator rewards
 * 2. Build batch transaction
 * 3. Send (if mode = 'on') or simulate
 * 4. Wait for confirmation
 * 5. Record in database
 * 6. Retry on failure
 */
@Injectable()
export class PaymentDistributorService {
  private readonly logger = new Logger(PaymentDistributorService.name);

  constructor(
    private readonly rewardCalculator: RewardCalculatorService,
    private readonly transactionService: TransactionService,
    private readonly walletService: WalletService,
    private readonly settingsRepo: SettingsRepository,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly delegatorsPaymentsRepo: DelegatorsPaymentsRepository,
  ) {}

  /**
   * Main distribution orchestrator
   * Implements full workflow from BUSINESS_LOGIC.md Section 1.1
   */
  async distributeCycleRewards(
    params: DistributionParams,
  ): Promise<DistributionResult> {
    this.logger.log(
      `Starting reward distribution for baker ${params.bakerId} cycle ${params.cycle} mode ${params.mode}`,
    );

    const errors: string[] = [];
    let retriesUsed = 0;

    try {
      // Step 1: Get settings
      const settings = await this.settingsRepo.findByBakerId(params.bakerId);
      if (!settings) {
        throw new Error(`Settings not found for baker ${params.bakerId}`);
      }

      // Step 2: Calculate rewards
      const cycleRewards = await this.rewardCalculator.calculateCycleRewards({
        bakerId: params.bakerId,
        cycle: params.cycle,
      });

      if (cycleRewards.delegatorRewards.length === 0) {
        this.logger.warn('No delegators to pay');
        return {
          success: true,
          cycle: params.cycle,
          mode: params.mode,
          totalDelegators: 0,
          totalAmount: new Decimal(0),
          applied: true,
          errors: [],
          retriesUsed: 0,
        };
      }

      // Step 3: Initialize wallet (if mode = ON)
      let signer: InMemorySigner | null = null;
      if (params.mode === OperationMode.ON) {
        signer = await this.initializeWallet(settings);
      }

      // Step 4: Execute distribution with retries
      const maxRetries = settings.paymentRetries;
      const minBetweenRetries = settings.minBetweenRetries;
      let blockchainConfirmed = false;
      let transactionHash: string | undefined;

      while (!blockchainConfirmed && retriesUsed < maxRetries) {
        retriesUsed++;

        this.logger.log(
          `Distribution attempt ${retriesUsed}/${maxRetries}`,
        );

        try {
          // Clear previous attempt data
          if (retriesUsed > 1) {
            await this.clearPreviousAttempt(params.bakerId, params.cycle);
          }

          // Execute distribution
          const result = await this.executeDistribution(
            params,
            cycleRewards.delegatorRewards,
            signer,
            settings.bakerId,
          );

          blockchainConfirmed = result.applied;
          transactionHash = result.transactionHash;

          if (!blockchainConfirmed && retriesUsed < maxRetries) {
            // Wait before retry
            const delayMs = minBetweenRetries * 60 * 1000;
            this.logger.log(
              `Waiting ${minBetweenRetries} minutes before retry...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        } catch (error) {
          this.logger.error(
            `Distribution attempt ${retriesUsed} failed: ${error.message}`,
          );
          errors.push(`Attempt ${retriesUsed}: ${error.message}`);

          if (retriesUsed < maxRetries) {
            const delayMs = minBetweenRetries * 60 * 1000;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }

      // Step 5: Update payment records
      await this.updatePaymentRecords(
        params.bakerId,
        params.cycle,
        cycleRewards.totalDelegatorPayments,
        blockchainConfirmed,
        params.mode,
        transactionHash,
      );

      return {
        success: blockchainConfirmed,
        cycle: params.cycle,
        mode: params.mode,
        totalDelegators: cycleRewards.delegatorRewards.length,
        totalAmount: cycleRewards.totalDelegatorPayments,
        transactionHash,
        applied: blockchainConfirmed,
        errors,
        retriesUsed,
      };
    } catch (error) {
      this.logger.error(`Distribution failed: ${error.message}`);
      errors.push(error.message);

      return {
        success: false,
        cycle: params.cycle,
        mode: params.mode,
        totalDelegators: 0,
        totalAmount: new Decimal(0),
        applied: false,
        errors,
        retriesUsed,
      };
    }
  }

  /**
   * Execute the distribution (send or simulate)
   * Based on BUSINESS_LOGIC.md Section 1.1 Steps 6-7
   */
  private async executeDistribution(
    params: DistributionParams,
    rewards: DelegatorReward[],
    signer: InMemorySigner | null,
    bakerAddress: string,
  ): Promise<{ applied: boolean; transactionHash?: string }> {
    // Step 1: Build batch transaction
    const batchTransfers = this.buildBatchTransaction(rewards);

    this.logger.log(
      `Built batch with ${batchTransfers.length} transfers, total: ${rewards.reduce((sum, r) => sum.plus(r.netReward), new Decimal(0)).toFixed(6)} XTZ`,
    );

    // Step 2: Save to database (before sending)
    await this.saveDelegatorPayments(
      params.bakerId,
      params.cycle,
      rewards,
      params.mode,
    );

    // Step 3: Send or simulate
    if (params.mode === OperationMode.ON && signer) {
      // Send real transaction
      this.logger.log('Sending batch transaction to blockchain...');

      const result = await this.transactionService.sendBatchTransaction(
        signer,
        bakerAddress,
        batchTransfers,
      );

      this.logger.log(
        `Batch transaction sent: ${result.opHash}, Applied: ${result.applied}`,
      );

      return {
        applied: result.applied,
        transactionHash: result.opHash,
      };
    } else {
      // Simulation mode
      this.logger.log('Simulation mode - no transaction sent');
      return {
        applied: true, // Simulation always succeeds
      };
    }
  }

  /**
   * Build batch transaction from delegator rewards
   * Based on BUSINESS_LOGIC.md Section 1.1 Step 6
   */
  private buildBatchTransaction(
    rewards: DelegatorReward[],
  ): BatchTransfer[] {
    const transfers: BatchTransfer[] = [];

    for (const reward of rewards) {
      if (reward.netRewardMutez > 0) {
        transfers.push({
          to: reward.address,
          amount: reward.netRewardMutez,
        });
      }
    }

    return transfers;
  }

  /**
   * Save delegator payments to database
   * Based on BUSINESS_LOGIC.md Section 1.1 Step 6
   */
  private async saveDelegatorPayments(
    bakerId: string,
    cycle: number,
    rewards: DelegatorReward[],
    mode: OperationMode,
  ): Promise<void> {
    this.logger.log(`Saving ${rewards.length} delegator payments to database`);

    for (const reward of rewards) {
      // Determine status based on mode
      let result: DelegatorPaymentStatus;
      if (mode === OperationMode.ON) {
        result = DelegatorPaymentStatus.APPLIED; // Will be updated after confirmation
      } else {
        result = DelegatorPaymentStatus.SIMULATED;
      }

      await this.delegatorsPaymentsRepo.create({
        bakerId,
        cycle,
        address: reward.address,
        date: new Date().toISOString(),
        result,
        total: reward.netReward.toNumber(),
      });
    }
  }

  /**
   * Update payment records after distribution
   * Based on BUSINESS_LOGIC.md Section 1.1 Step 9
   */
  private async updatePaymentRecords(
    bakerId: string,
    cycle: number,
    totalAmount: Decimal,
    success: boolean,
    mode: OperationMode,
    transactionHash?: string,
  ): Promise<void> {
    this.logger.log('Updating payment records');

    // Update main payment record
    const payments = await this.paymentsRepo.findByBakerAndCycle(
      bakerId,
      cycle,
    );

    if (payments.length > 0) {
      const paymentStatus = mode === OperationMode.ON
        ? (success ? PaymentStatus.PAID : PaymentStatus.ERRORS)
        : PaymentStatus.SIMULATED;

      await this.paymentsRepo.update(payments[0].id, {
        result: paymentStatus,
        total: totalAmount.toNumber(),
        transactionHash,
      });
    }

    // Update delegator payment records
    if (mode === OperationMode.ON) {
      const delegatorStatus = success
        ? DelegatorPaymentStatus.APPLIED
        : DelegatorPaymentStatus.FAILED;

      const delegatorPayments =
        await this.delegatorsPaymentsRepo.findByBakerAndCycle(bakerId, cycle);

      for (const payment of delegatorPayments) {
        await this.delegatorsPaymentsRepo.update(payment.id, {
          result: delegatorStatus,
          transactionHash,
        });
      }
    }
  }

  /**
   * Initialize wallet from encrypted data
   */
  private async initializeWallet(settings: any): Promise<InMemorySigner> {
    this.logger.log('Initializing wallet for payments');

    // Decrypt wallet
    const encryptedWallet = {
      ciphertext: settings.encryptedPassphrase || '',
      iv: settings.walletSalt || '',
      salt: settings.hashSalt || '',
      tag: settings.walletHash || '',
    };

    const password = settings.appPassphrase || '';
    const secretKey = await this.walletService.decryptWallet(
      encryptedWallet,
      password,
    );

    // Import wallet
    const signer = await this.walletService.importFromSecretKey(secretKey);

    this.logger.log('Wallet initialized successfully');
    return signer;
  }

  /**
   * Clear previous attempt data
   * Based on BUSINESS_LOGIC.md Section 1.1 Step 5
   */
  private async clearPreviousAttempt(
    bakerId: string,
    cycle: number,
  ): Promise<void> {
    this.logger.log('Clearing previous attempt data');

    // Delete delegator payments from previous attempt
    const delegatorPayments =
      await this.delegatorsPaymentsRepo.findByBakerAndCycle(bakerId, cycle);

    for (const payment of delegatorPayments) {
      await this.delegatorsPaymentsRepo.delete(payment.id);
    }
  }
}
