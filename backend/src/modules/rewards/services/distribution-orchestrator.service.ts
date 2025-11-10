import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CycleDetectorService } from './cycle-detector.service';
import { RewardCalculatorService } from './reward-calculator.service';
import { PaymentDistributorService } from './payment-distributor.service';
import { RewardValidatorService } from './reward-validator.service';
import { BondPoolService } from '../../bond-pool/services/bond-pool.service';
import { TransactionService } from '../../blockchain/services/transaction.service';
import { WalletService } from '../../wallet/services/wallet.service';
import { SettingsRepository, BondPoolRepository } from '../../../database/repositories';
import { OperationMode } from '../../../shared/constants';

/**
 * Full distribution result
 */
export interface FullDistributionResult {
  success: boolean;
  bakerId: string;
  cycle: number;
  delegatorDistribution: {
    success: boolean;
    totalDelegators: number;
    totalAmount: string;
    transactionHash?: string;
  };
  bondPoolDistribution?: {
    success: boolean;
    totalMembers: number;
    totalAmount: string;
    transactionHash?: string;
  };
  errors: string[];
}

/**
 * Distribution Orchestrator Service
 *
 * Main entry point for the complete reward distribution process
 * Orchestrates cycle detection, reward calculation, payment distribution, and bond pool
 *
 * Based on BUSINESS_LOGIC.md complete workflow
 */
@Injectable()
export class DistributionOrchestratorService {
  private readonly logger = new Logger(DistributionOrchestratorService.name);

  constructor(
    private readonly cycleDetector: CycleDetectorService,
    private readonly rewardCalculator: RewardCalculatorService,
    private readonly paymentDistributor: PaymentDistributorService,
    private readonly bondPoolService: BondPoolService,
    private readonly rewardValidator: RewardValidatorService,
    private readonly transactionService: TransactionService,
    private readonly walletService: WalletService,
    private readonly settingsRepo: SettingsRepository,
    private readonly bondPoolRepo: BondPoolRepository,
  ) {}

  /**
   * Process full rewards distribution for a baker
   * Called by scheduled job or manual trigger
   *
   * Full workflow from BUSINESS_LOGIC.md:
   * 1. Detect cycle changes
   * 2. Check if rewards are available
   * 3. Calculate delegator rewards
   * 4. Validate calculations
   * 5. Distribute to delegators
   * 6. Calculate bond pool (if enabled)
   * 7. Distribute to bond pool
   * 8. Update all database records
   * 9. Log complete audit trail
   */
  async processRewardsDistribution(
    bakerId: string,
  ): Promise<FullDistributionResult> {
    this.logger.log(`=== Starting rewards distribution for baker ${bakerId} ===`);

    const errors: string[] = [];

    try {
      // Step 1: Get settings
      const settings = await this.settingsRepo.findByBakerId(bakerId);
      if (!settings) {
        throw new Error(`Settings not found for baker ${bakerId}`);
      }

      const operationMode = settings.mode as OperationMode;
      this.logger.log(`Operation mode: ${operationMode}`);

      // Step 2: Update cycle tracking
      const cycleChange = await this.cycleDetector.updateCycleTracking(bakerId);

      // Step 3: Get cycles ready for distribution
      const readyCycles = await this.cycleDetector.getCyclesReadyForDistribution(bakerId);

      if (readyCycles.length === 0) {
        this.logger.log('No cycles ready for distribution');
        return {
          success: true,
          bakerId,
          cycle: cycleChange.currentCycle,
          delegatorDistribution: {
            success: true,
            totalDelegators: 0,
            totalAmount: '0',
          },
          errors: [],
        };
      }

      // Process the first ready cycle
      const cycleToProcess = readyCycles[0];
      this.logger.log(`Processing cycle ${cycleToProcess.cycle}`);

      // Step 4: Calculate delegator rewards
      this.logger.log('Calculating delegator rewards...');
      const cycleRewards = await this.rewardCalculator.calculateCycleRewards({
        bakerId,
        cycle: cycleToProcess.cycle,
      });

      // Step 5: Validate delegator rewards
      const delegatorValidation = this.rewardValidator.validateDelegatorRewards(
        cycleRewards.delegatorRewards,
        cycleRewards.totalRewards,
      );
      this.rewardValidator.logValidation(delegatorValidation, 'Delegator rewards');

      if (!delegatorValidation.valid) {
        errors.push(...delegatorValidation.errors);
        throw new Error('Delegator reward validation failed');
      }

      // Step 6: Distribute to delegators
      this.logger.log('Distributing to delegators...');
      const delegatorResult = await this.paymentDistributor.distributeCycleRewards({
        bakerId,
        cycle: cycleToProcess.cycle,
        mode: operationMode,
      });

      if (!delegatorResult.success) {
        errors.push(...delegatorResult.errors);
      }

      // Step 7: Calculate and distribute bond pool (if enabled and delegator distribution succeeded)
      let bondPoolResult: any = null;
      const bondPoolSettings = await this.bondPoolRepo.findSettingsByBakerId(bakerId);

      if (bondPoolSettings?.isEnabled() && delegatorResult.success) {
        this.logger.log('Calculating bond pool rewards...');

        const bondPoolDistribution = await this.bondPoolService.calculateBondPoolRewards({
          bakerId,
          cycle: cycleToProcess.cycle,
          totalCycleRewards: cycleRewards.totalRewards,
          totalDelegatorPayments: cycleRewards.totalDelegatorPayments,
        });

        // Validate bond pool distribution
        const bondPoolValidation = this.rewardValidator.validateBondPoolDistribution(
          bondPoolDistribution,
        );
        this.rewardValidator.logValidation(bondPoolValidation, 'Bond pool');

        if (bondPoolValidation.valid && bondPoolDistribution.memberRewards.length > 0) {
          this.logger.log('Distributing to bond pool...');

          // Build batch transfers
          const bondPoolTransfers = await this.bondPoolService.buildBondPoolBatchTransfers(
            bondPoolDistribution,
          );

          // Send batch (if mode = ON)
          if (operationMode === OperationMode.ON) {
            // Initialize wallet
            const signer = await this.initializeWallet(settings);

            // Send batch
            const batchResult = await this.transactionService.sendBatchTransaction(
              signer,
              bakerId,
              bondPoolTransfers,
            );

            bondPoolResult = {
              success: batchResult.applied,
              totalMembers: bondPoolDistribution.memberRewards.length,
              totalAmount: bondPoolDistribution.totalDistributed.toFixed(6),
              transactionHash: batchResult.opHash,
            };
          } else {
            // Simulation
            bondPoolResult = {
              success: true,
              totalMembers: bondPoolDistribution.memberRewards.length,
              totalAmount: bondPoolDistribution.totalDistributed.toFixed(6),
            };
          }
        }
      }

      // Step 8: Log summary
      const summary = this.rewardCalculator.getSummary(cycleRewards);
      this.logger.log(`=== Distribution Summary ===`);
      this.logger.log(`Cycle: ${cycleToProcess.cycle}`);
      this.logger.log(`Total Rewards: ${summary.totalRewards} XTZ`);
      this.logger.log(`Delegator Payments: ${summary.totalDelegatorPayments} XTZ (${summary.delegatorCount} delegators)`);
      this.logger.log(`Total Fees: ${summary.totalFees} XTZ`);
      this.logger.log(`Baker Share: ${summary.bakerShare} XTZ`);
      if (bondPoolResult) {
        this.logger.log(`Bond Pool: ${bondPoolResult.totalAmount} XTZ (${bondPoolResult.totalMembers} members)`);
      }
      this.logger.log(`=== Distribution Complete ===`);

      return {
        success: delegatorResult.success,
        bakerId,
        cycle: cycleToProcess.cycle,
        delegatorDistribution: {
          success: delegatorResult.success,
          totalDelegators: delegatorResult.totalDelegators,
          totalAmount: delegatorResult.totalAmount.toFixed(6),
          transactionHash: delegatorResult.transactionHash,
        },
        bondPoolDistribution: bondPoolResult,
        errors,
      };
    } catch (error) {
      this.logger.error(`Distribution failed: ${error.message}`);
      errors.push(error.message);

      return {
        success: false,
        bakerId,
        cycle: 0,
        delegatorDistribution: {
          success: false,
          totalDelegators: 0,
          totalAmount: '0',
        },
        errors,
      };
    }
  }

  /**
   * Initialize wallet from settings
   */
  private async initializeWallet(settings: any): Promise<any> {
    // This would use the wallet service to decrypt and initialize
    // For now, just a placeholder
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

    return await this.walletService.importFromSecretKey(secretKey);
  }
}
