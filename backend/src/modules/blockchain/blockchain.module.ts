import { Module } from '@nestjs/common';
import { TezosClientService } from './services/tezos-client.service';
import { TransactionService } from './services/transaction.service';
import { TzKTClientService } from './services/tzkt-client.service';

/**
 * Blockchain module
 * Provides Tezos blockchain integration services
 */
@Module({
  providers: [
    TezosClientService,
    TransactionService,
    TzKTClientService,
  ],
  exports: [
    TezosClientService,
    TransactionService,
    TzKTClientService,
  ],
})
export class BlockchainModule {}
