import { Injectable, Logger } from '@nestjs/common';
import { TezosToolkit, OpKind } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
import Decimal from 'decimal.js';
import {
  getTezosConfig,
  TEZOS_CONSTANTS,
  tezToMutez,
  mutezToTez,
} from '../../../config/tezos.config';
import { TezosClientService } from './tezos-client.service';

/**
 * Single transaction parameters
 */
export interface TransactionParams {
  from: string;
  to: string;
  amount: number; // in mutez
  fee?: number; // in mutez
  gasLimit?: number;
  storageLimit?: number;
}

/**
 * Batch transfer entry
 */
export interface BatchTransfer {
  to: string;
  amount: number; // in mutez
}

/**
 * Transaction result
 */
export interface TransactionResult {
  opHash: string;
  applied: boolean;
  consumedGas: number;
  includedInBlock: number;
  fee: number; // in mutez
}

/**
 * Batch transaction result
 */
export interface BatchResult {
  opHash: string;
  applied: boolean;
  consumedGas: number;
  includedInBlock: number;
  totalAmount: number; // in mutez
  successfulTransfers: number;
  failedTransfers: number;
  fee: number; // in mutez
}

/**
 * Transaction service for sending single and batch transactions
 * CRITICAL: All amounts are in mutez unless specified otherwise
 * Uses Decimal.js for all financial calculations
 */
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);
  private readonly config = getTezosConfig();

  constructor(private readonly tezosClient: TezosClientService) {}

  /**
   * Send a single transaction
   */
  async sendTransaction(
    signer: InMemorySigner,
    params: TransactionParams,
  ): Promise<TransactionResult> {
    try {
      this.logger.log(
        `Sending transaction: ${params.from} -> ${params.to}, amount: ${mutezToTez(params.amount)} XTZ`,
      );

      // Get Tezos toolkit
      const tezos = this.tezosClient.getToolkit();

      // Set signer
      tezos.setProvider({ signer });

      // Validate amount
      if (params.amount < 0) {
        throw new Error('Transaction amount cannot be negative');
      }

      // Convert to tez for Taquito (it expects tez, not mutez)
      const amountInTez = mutezToTez(params.amount);

      // Prepare transaction parameters
      const transferParams = {
        to: params.to,
        amount: amountInTez,
        fee: params.fee,
        gasLimit: params.gasLimit || this.config.gasLimit,
        storageLimit: params.storageLimit || this.config.storageLimit,
      };

      // Execute transaction
      const operation = await tezos.wallet.transfer(transferParams).send();

      this.logger.log(`Transaction submitted: ${operation.opHash}`);

      // Wait for confirmation
      const confirmation = await operation.confirmation(1);

      this.logger.log(
        `Transaction confirmed in block ${confirmation.block.header.level}`,
      );

      return {
        opHash: operation.opHash,
        applied: true,
        consumedGas: confirmation.totalGasConsumed || 0,
        includedInBlock: confirmation.block.header.level,
        fee: params.fee || tezToMutez(this.config.transactionFee),
      };
    } catch (error) {
      this.logger.error(`Transaction failed: ${error.message}`);
      throw new Error(`Transaction failed: ${error.message}`);
    }
  }

  /**
   * Send batch transaction (CRITICAL for rewards distribution)
   * This is the main method used for paying multiple delegators in one operation
   */
  async sendBatchTransaction(
    signer: InMemorySigner,
    from: string,
    transfers: BatchTransfer[],
  ): Promise<BatchResult> {
    try {
      // Validate batch size
      if (transfers.length === 0) {
        throw new Error('Batch cannot be empty');
      }

      if (transfers.length > TEZOS_CONSTANTS.MAX_BATCH_SIZE) {
        throw new Error(
          `Batch size ${transfers.length} exceeds maximum ${TEZOS_CONSTANTS.MAX_BATCH_SIZE}`,
        );
      }

      this.logger.log(
        `Preparing batch transaction with ${transfers.length} transfers from ${from}`,
      );

      // Calculate total amount using Decimal.js
      let totalMutez = new Decimal(0);
      for (const transfer of transfers) {
        if (transfer.amount < 0) {
          throw new Error(`Invalid negative amount in batch transfer to ${transfer.to}`);
        }
        totalMutez = totalMutez.plus(transfer.amount);
      }

      this.logger.log(
        `Total batch amount: ${mutezToTez(totalMutez.toNumber())} XTZ`,
      );

      // Get Tezos toolkit
      const tezos = this.tezosClient.getToolkit();

      // Set signer
      tezos.setProvider({ signer });

      // Create batch operation
      const batch = tezos.wallet.batch([]);

      // Add all transfers to batch
      for (const transfer of transfers) {
        batch.withTransfer({
          to: transfer.to,
          amount: mutezToTez(transfer.amount), // Taquito expects tez
          storageLimit: 0, // No storage needed for simple transfers
        });
      }

      // Execute batch
      this.logger.log('Sending batch transaction...');
      const operation = await batch.send();

      this.logger.log(`Batch transaction submitted: ${operation.opHash}`);

      // Wait for confirmation
      const confirmation = await operation.confirmation(1);

      this.logger.log(
        `Batch transaction confirmed in block ${confirmation.block.header.level}`,
      );

      // Count successful and failed transfers
      let successfulTransfers = 0;
      let failedTransfers = 0;

      if (confirmation.completed) {
        // All transfers succeeded
        successfulTransfers = transfers.length;
      } else {
        // Some transfers may have failed
        // Note: In practice, if one fails, the entire batch fails
        failedTransfers = transfers.length;
      }

      return {
        opHash: operation.opHash,
        applied: confirmation.completed,
        consumedGas: confirmation.totalGasConsumed || 0,
        includedInBlock: confirmation.block.header.level,
        totalAmount: totalMutez.toNumber(),
        successfulTransfers,
        failedTransfers,
        fee: tezToMutez(this.config.transactionFee * transfers.length),
      };
    } catch (error) {
      this.logger.error(`Batch transaction failed: ${error.message}`);
      throw new Error(`Batch transaction failed: ${error.message}`);
    }
  }

  /**
   * Estimate gas for a single transaction
   */
  async estimateTransactionGas(params: TransactionParams): Promise<number> {
    try {
      const estimate = await this.tezosClient.estimateGas({
        to: params.to,
        amount: mutezToTez(params.amount),
      });

      return estimate;
    } catch (error) {
      this.logger.warn(`Gas estimation failed: ${error.message}`);
      return this.config.gasLimit;
    }
  }

  /**
   * Estimate gas for a batch transaction
   */
  async estimateBatchGas(transfers: BatchTransfer[]): Promise<number> {
    try {
      // Estimate gas per transfer and sum them up
      let totalGas = 0;

      for (const transfer of transfers) {
        const estimate = await this.tezosClient.estimateGas({
          to: transfer.to,
          amount: mutezToTez(transfer.amount),
        });
        totalGas += estimate;
      }

      // Add some buffer (10%)
      return Math.ceil(totalGas * 1.1);
    } catch (error) {
      this.logger.warn(`Batch gas estimation failed: ${error.message}`);
      // Use default gas limit per transfer
      return this.config.gasLimit * transfers.length;
    }
  }

  /**
   * Calculate total fee for batch transaction
   */
  calculateBatchFee(transferCount: number): number {
    // Fee per transfer in mutez
    const feePerTransfer = tezToMutez(this.config.transactionFee);

    // Total fee using Decimal.js
    const totalFee = new Decimal(feePerTransfer)
      .times(transferCount)
      .toNumber();

    return Math.ceil(totalFee);
  }

  /**
   * Validate batch transfers before sending
   */
  validateBatchTransfers(transfers: BatchTransfer[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (transfers.length === 0) {
      errors.push('Batch cannot be empty');
    }

    if (transfers.length > TEZOS_CONSTANTS.MAX_BATCH_SIZE) {
      errors.push(
        `Batch size ${transfers.length} exceeds maximum ${TEZOS_CONSTANTS.MAX_BATCH_SIZE}`,
      );
    }

    // Check each transfer
    for (let i = 0; i < transfers.length; i++) {
      const transfer = transfers[i];

      if (!transfer.to) {
        errors.push(`Transfer ${i}: Missing recipient address`);
      }

      if (transfer.amount < 0) {
        errors.push(`Transfer ${i}: Amount cannot be negative`);
      }

      if (transfer.amount === 0) {
        errors.push(`Transfer ${i}: Amount cannot be zero`);
      }
    }

    // Check for duplicate addresses (optional warning)
    const addresses = transfers.map(t => t.to);
    const duplicates = addresses.filter(
      (addr, index) => addresses.indexOf(addr) !== index,
    );

    if (duplicates.length > 0) {
      this.logger.warn(
        `Batch contains duplicate addresses: ${duplicates.join(', ')}`,
      );
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Split large batch into smaller chunks
   */
  splitBatch(
    transfers: BatchTransfer[],
    maxBatchSize: number = TEZOS_CONSTANTS.MAX_BATCH_SIZE,
  ): BatchTransfer[][] {
    const chunks: BatchTransfer[][] = [];

    for (let i = 0; i < transfers.length; i += maxBatchSize) {
      chunks.push(transfers.slice(i, i + maxBatchSize));
    }

    this.logger.log(
      `Split ${transfers.length} transfers into ${chunks.length} batches`,
    );

    return chunks;
  }

  /**
   * Send multiple batch transactions (for very large delegator lists)
   */
  async sendMultipleBatches(
    signer: InMemorySigner,
    from: string,
    transfers: BatchTransfer[],
  ): Promise<BatchResult[]> {
    // Split into chunks
    const batches = this.splitBatch(transfers);

    const results: BatchResult[] = [];

    for (let i = 0; i < batches.length; i++) {
      this.logger.log(`Processing batch ${i + 1}/${batches.length}`);

      const result = await this.sendBatchTransaction(
        signer,
        from,
        batches[i],
      );

      results.push(result);

      // Wait a bit between batches to avoid overwhelming the node
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    return results;
  }
}
