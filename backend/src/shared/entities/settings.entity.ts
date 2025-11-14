import { Settings as PrismaSettings } from '@prisma/client';
import { OperationMode } from '../constants';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Settings entity with business logic
 * Represents baker configuration and operational settings
 */
export class SettingsEntity {
  bakerId: string;
  defaultFee: Decimal;
  updateFreq: number;
  userName?: string | null;
  passHash?: string | null;
  applicationPort: number;
  mode: OperationMode;
  hashSalt?: string | null;
  walletHash?: string | null;
  walletSalt?: string | null;
  encryptedPassphrase?: string | null;
  appPassphrase?: string | null;
  delegate?: string | null;
  proxyServer?: string | null;
  proxyPort: number;
  provider: string;
  gasLimit: number;
  storageLimit: number;
  transactionFee: Decimal;
  blockExplorer: string;
  numBlocksWait: number;
  paymentRetries: number;
  minBetweenRetries: number;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: PrismaSettings) {
    this.bakerId = data.bakerId;
    this.defaultFee = data.defaultFee;
    this.updateFreq = data.updateFreq;
    this.userName = data.userName;
    this.passHash = data.passHash;
    this.applicationPort = data.applicationPort;
    this.mode = data.mode as OperationMode;
    this.hashSalt = data.hashSalt;
    this.walletHash = data.walletHash;
    this.walletSalt = data.walletSalt;
    this.encryptedPassphrase = data.encryptedPassphrase;
    this.appPassphrase = data.appPassphrase;
    this.delegate = data.delegate;
    this.proxyServer = data.proxyServer;
    this.proxyPort = data.proxyPort;
    this.provider = data.provider;
    this.gasLimit = data.gasLimit;
    this.storageLimit = data.storageLimit;
    this.transactionFee = data.transactionFee;
    this.blockExplorer = data.blockExplorer;
    this.numBlocksWait = data.numBlocksWait;
    this.paymentRetries = data.paymentRetries;
    this.minBetweenRetries = data.minBetweenRetries;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * Check if payments are enabled (mode is ON)
   */
  isPaymentsEnabled(): boolean {
    return this.mode === OperationMode.ON;
  }

  /**
   * Check if in simulation mode
   */
  isSimulationMode(): boolean {
    return this.mode === OperationMode.SIMULATION;
  }

  /**
   * Check if payments are disabled
   */
  isPaymentsDisabled(): boolean {
    return this.mode === OperationMode.OFF;
  }

  /**
   * Validate fee percentage (0-100)
   */
  static isValidFee(fee: number): boolean {
    return fee >= 0 && fee <= 100;
  }

  /**
   * Get default fee as a decimal (e.g., 5% -> 0.05)
   */
  getDefaultFeeDecimal(): number {
    return this.defaultFee.toNumber() / 100;
  }

  /**
   * Get transaction fee in tez (from mutez)
   */
  getTransactionFeeTez(): number {
    return this.transactionFee.toNumber();
  }

  /**
   * Check if wallet credentials are configured
   */
  hasWalletCredentials(): boolean {
    return !!(
      this.walletHash &&
      this.walletSalt &&
      this.encryptedPassphrase
    );
  }

  /**
   * Check if authentication is configured
   */
  hasAuthentication(): boolean {
    return !!(this.userName && this.passHash && this.hashSalt);
  }

  /**
   * Check if proxy is configured
   */
  hasProxy(): boolean {
    return !!(this.proxyServer && this.proxyPort);
  }

  /**
   * Get full proxy URL
   */
  getProxyUrl(): string | null {
    if (!this.hasProxy()) {
      return null;
    }
    return `${this.proxyServer}:${this.proxyPort}`;
  }

  /**
   * Validate that required settings are configured
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.bakerId || this.bakerId.trim().length === 0) {
      errors.push('Baker ID is required');
    }

    if (!SettingsEntity.isValidFee(this.defaultFee.toNumber())) {
      errors.push('Default fee must be between 0 and 100');
    }

    if (this.updateFreq < 1) {
      errors.push('Update frequency must be at least 1');
    }

    if (this.applicationPort < 1 || this.applicationPort > 65535) {
      errors.push('Application port must be between 1 and 65535');
    }

    if (!this.provider || this.provider.trim().length === 0) {
      errors.push('Provider URL is required');
    }

    if (this.gasLimit < 0) {
      errors.push('Gas limit cannot be negative');
    }

    if (this.storageLimit < 0) {
      errors.push('Storage limit cannot be negative');
    }

    if (this.transactionFee.toNumber() < 0) {
      errors.push('Transaction fee cannot be negative');
    }

    if (!this.blockExplorer || this.blockExplorer.trim().length === 0) {
      errors.push('Block explorer URL is required');
    }

    if (this.numBlocksWait < 1) {
      errors.push('Number of blocks to wait must be at least 1');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON() {
    return {
      bakerId: this.bakerId,
      defaultFee: this.defaultFee.toNumber(),
      updateFreq: this.updateFreq,
      userName: this.userName,
      applicationPort: this.applicationPort,
      mode: this.mode,
      delegate: this.delegate,
      proxyServer: this.proxyServer,
      proxyPort: this.proxyPort,
      provider: this.provider,
      gasLimit: this.gasLimit,
      storageLimit: this.storageLimit,
      transactionFee: this.transactionFee.toNumber(),
      blockExplorer: this.blockExplorer,
      numBlocksWait: this.numBlocksWait,
      paymentRetries: this.paymentRetries,
      minBetweenRetries: this.minBetweenRetries,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
