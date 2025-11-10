import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletModule } from '../wallet/wallet.module';
import { BondPoolModule } from '../bond-pool/bond-pool.module';
import { RewardCalculatorService } from './services/reward-calculator.service';
import { CycleDetectorService } from './services/cycle-detector.service';
import { PaymentDistributorService } from './services/payment-distributor.service';
import { RewardValidatorService } from './services/reward-validator.service';
import { DistributionOrchestratorService } from './services/distribution-orchestrator.service';

/**
 * Rewards module
 * Handles reward calculation and distribution
 */
@Module({
  imports: [DatabaseModule, BlockchainModule, WalletModule, BondPoolModule],
  providers: [
    RewardCalculatorService,
    CycleDetectorService,
    PaymentDistributorService,
    RewardValidatorService,
    DistributionOrchestratorService,
  ],
  exports: [
    RewardCalculatorService,
    CycleDetectorService,
    PaymentDistributorService,
    RewardValidatorService,
    DistributionOrchestratorService,
  ],
})
export class RewardsModule {}
