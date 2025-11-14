import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TezosToolkit } from '@taquito/taquito';
import { getTezosConfig, TEZOS_CONSTANTS } from '../../../config/tezos.config';
import Decimal from 'decimal.js';

/**
 * Block metadata from Tezos RPC
 */
export interface BlockMetadata {
  level: number;
  hash: string;
  timestamp: Date;
  cycle: number;
  baker: string;
}

/**
 * Blockchain constants from protocol
 */
export interface BlockchainConstants {
  blocksPerCycle: number;
  blocksPerCommitment: number;
  blocksPerVotingPeriod: number;
  timeBetweenBlocks: number[];
  endorsersPerBlock: number;
  hardGasLimitPerOperation: string;
  hardGasLimitPerBlock: string;
  hardStorageLimitPerOperation: string;
}

/**
 * TezosClient service for blockchain RPC operations
 * Handles connection to Tezos node, retries, and failover
 */
@Injectable()
export class TezosClientService implements OnModuleInit {
  private readonly logger = new Logger(TezosClientService.name);
  private tezos: TezosToolkit;
  private config = getTezosConfig();
  private currentRpcIndex = 0;
  private rpcUrls: string[];

  constructor() {
    this.rpcUrls = [
      this.config.rpcUrl,
      ...(this.config.fallbackRpcUrls || []),
    ];
    this.tezos = new TezosToolkit(this.rpcUrls[0]);
  }

  async onModuleInit() {
    await this.initialize(this.config.rpcUrl);
  }

  /**
   * Initialize Tezos client with provider
   */
  async initialize(provider: string): Promise<void> {
    try {
      this.tezos = new TezosToolkit(provider);
      this.logger.log(`Tezos client initialized with provider: ${provider}`);

      // Test connection
      const block = await this.tezos.rpc.getBlockHeader();
      this.logger.log(
        `Connected to Tezos network at block level: ${block.level}`,
      );
    } catch (error) {
      this.logger.error(`Failed to initialize Tezos client: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute RPC call with retry and failover
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `${operationName} attempt ${attempt}/${this.config.retryAttempts} failed: ${error.message}`,
        );

        // Try next RPC URL if available
        if (attempt < this.config.retryAttempts && this.rpcUrls.length > 1) {
          this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
          const nextRpc = this.rpcUrls[this.currentRpcIndex];
          this.logger.log(`Switching to fallback RPC: ${nextRpc}`);
          this.tezos = new TezosToolkit(nextRpc);
        }

        // Exponential backoff
        if (attempt < this.config.retryAttempts) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `${operationName} failed after ${this.config.retryAttempts} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Get balance for an address (in tez)
   */
  async getBalance(address: string): Promise<number> {
    return this.executeWithRetry(async () => {
      const balance = await this.tezos.tz.getBalance(address);
      return new Decimal(balance.toNumber())
        .div(TEZOS_CONSTANTS.MUTEZ_PER_TEZ)
        .toNumber();
    }, `getBalance(${address})`);
  }

  /**
   * Get current cycle number
   */
  async getCurrentCycle(): Promise<number> {
    return this.executeWithRetry(async () => {
      const block = await this.tezos.rpc.getBlockHeader();
      const metadata = await this.tezos.rpc.getBlockMetadata();
      return metadata.level.cycle;
    }, 'getCurrentCycle');
  }

  /**
   * Get current block level
   */
  async getCurrentLevel(): Promise<number> {
    return this.executeWithRetry(async () => {
      const block = await this.tezos.rpc.getBlockHeader();
      return block.level;
    }, 'getCurrentLevel');
  }

  /**
   * Get block metadata
   */
  async getBlockMetadata(level?: number): Promise<BlockMetadata> {
    return this.executeWithRetry(async () => {
      const blockId = level ? String(level) : 'head';
      const header = await this.tezos.rpc.getBlockHeader({ block: blockId });
      const metadata = await this.tezos.rpc.getBlockMetadata({ block: blockId });

      return {
        level: header.level,
        hash: header.hash,
        timestamp: new Date(header.timestamp),
        cycle: metadata.level.cycle,
        baker: header.baker,
      };
    }, `getBlockMetadata(${level || 'head'})`);
  }

  /**
   * Get blockchain constants from protocol
   */
  async getConstants(): Promise<BlockchainConstants> {
    return this.executeWithRetry(async () => {
      const constants = await this.tezos.rpc.getConstants();
      return {
        blocksPerCycle: constants.blocks_per_cycle,
        blocksPerCommitment: constants.blocks_per_commitment,
        blocksPerVotingPeriod: constants.blocks_per_voting_period,
        timeBetweenBlocks: constants.time_between_blocks.map(t => parseInt(t)),
        endorsersPerBlock: constants.endorsers_per_block,
        hardGasLimitPerOperation: constants.hard_gas_limit_per_operation.toString(),
        hardGasLimitPerBlock: constants.hard_gas_limit_per_block.toString(),
        hardStorageLimitPerOperation: constants.hard_storage_limit_per_operation.toString(),
      };
    }, 'getConstants');
  }

  /**
   * Get delegated contracts for a baker
   */
  async getDelegatedContracts(baker: string): Promise<string[]> {
    return this.executeWithRetry(async () => {
      const delegates = await this.tezos.rpc.getDelegates(baker);
      return delegates.delegated_contracts || [];
    }, `getDelegatedContracts(${baker})`);
  }

  /**
   * Wait for operation confirmation
   */
  async waitForConfirmation(
    opHash: string,
    blocks: number = this.config.confirmationBlocks,
  ): Promise<boolean> {
    return this.executeWithRetry(async () => {
      this.logger.log(
        `Waiting for ${blocks} confirmations for operation ${opHash}`,
      );

      try {
        const confirmation = await this.tezos.rpc.confirmOperation(
          opHash,
          blocks,
        );
        return confirmation !== null;
      } catch (error) {
        this.logger.error(
          `Error waiting for confirmation: ${error.message}`,
        );
        return false;
      }
    }, `waitForConfirmation(${opHash})`);
  }

  /**
   * Get operation status
   */
  async getOperationStatus(opHash: string): Promise<any> {
    return this.executeWithRetry(async () => {
      // Try to get operation from mempool first
      try {
        const pendingOps = await this.tezos.rpc.getPendingOperations();
        const found = pendingOps.applied.find(op => op.hash === opHash) ||
                     pendingOps.branch_delayed.find(op => op.hash === opHash) ||
                     pendingOps.branch_refused.find(op => op.hash === opHash) ||
                     pendingOps.refused.find(op => op.hash === opHash);

        if (found) {
          return { status: 'pending', operation: found };
        }
      } catch (error) {
        this.logger.debug(`Operation not in mempool: ${error.message}`);
      }

      // Try to get from blocks
      const blockHeader = await this.tezos.rpc.getBlockHeader();
      const operations = await this.tezos.rpc.getBlock({
        block: blockHeader.hash,
      });

      // Search in recent blocks
      for (const opGroup of operations.operations) {
        for (const ops of opGroup) {
          if (ops.hash === opHash) {
            return { status: 'applied', operation: ops };
          }
        }
      }

      return { status: 'unknown', operation: null };
    }, `getOperationStatus(${opHash})`);
  }

  /**
   * Estimate gas for operation
   */
  async estimateGas(operation: any): Promise<number> {
    return this.executeWithRetry(async () => {
      try {
        const estimate = await this.tezos.estimate.transfer(operation);
        return estimate.gasLimit;
      } catch (error) {
        this.logger.warn(`Gas estimation failed, using default: ${error.message}`);
        return this.config.gasLimit;
      }
    }, 'estimateGas');
  }

  /**
   * Estimate storage for operation
   */
  async estimateStorage(operation: any): Promise<number> {
    return this.executeWithRetry(async () => {
      try {
        const estimate = await this.tezos.estimate.transfer(operation);
        return estimate.storageLimit;
      } catch (error) {
        this.logger.warn(`Storage estimation failed, using default: ${error.message}`);
        return this.config.storageLimit;
      }
    }, 'estimateStorage');
  }

  /**
   * Get the underlying TezosToolkit instance
   */
  getToolkit(): TezosToolkit {
    return this.tezos;
  }

  /**
   * Get current RPC URL
   */
  getCurrentRpcUrl(): string {
    return this.rpcUrls[this.currentRpcIndex];
  }

  /**
   * Health check for Tezos connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      const block = await this.tezos.rpc.getBlockHeader();
      return block.level > 0;
    } catch (error) {
      this.logger.error(`Health check failed: ${error.message}`);
      return false;
    }
  }
}
