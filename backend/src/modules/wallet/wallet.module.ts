import { Module } from '@nestjs/common';
import { WalletService } from './services/wallet.service';

/**
 * Wallet module
 * Provides wallet management services
 */
@Module({
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
