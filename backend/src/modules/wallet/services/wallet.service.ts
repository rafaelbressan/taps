import { Injectable, Logger } from '@nestjs/common';
import { InMemorySigner } from '@taquito/signer';
import { validateAddress, ValidationResult } from '@taquito/utils';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { isValidTezosAddress } from '../../../config/tezos.config';

/**
 * Encrypted wallet structure
 */
export interface EncryptedWallet {
  ciphertext: string;
  iv: string;
  salt: string;
  tag: string;
}

/**
 * Wallet information
 */
export interface WalletInfo {
  publicKeyHash: string;
  publicKey: string;
}

/**
 * Wallet service for managing Tezos wallets
 * Handles wallet creation, encryption/decryption, and signing
 *
 * SECURITY NOTES:
 * - Private keys are never logged
 * - Memory is cleaned after sensitive operations
 * - Dual encryption: user password + app seed
 * - Uses AES-256-GCM for encryption
 * - bcrypt for password hashing
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly ENCRYPTION_ALGORITHM = 'aes-256-gcm';
  private readonly KEY_LENGTH = 32; // 256 bits
  private readonly IV_LENGTH = 16;
  private readonly SALT_LENGTH = 64;
  private readonly TAG_LENGTH = 16;

  /**
   * Import wallet from mnemonic and passphrase
   */
  async importWallet(
    mnemonic: string,
    passphrase: string = '',
  ): Promise<InMemorySigner> {
    try {
      this.logger.log('Importing wallet from mnemonic');

      const signer = InMemorySigner.fromMnemonic({
        mnemonic: mnemonic.trim(),
        password: passphrase,
      });

      // Verify the wallet was imported successfully
      const pkh = await signer.publicKeyHash();
      this.logger.log(`Wallet imported successfully: ${pkh}`);

      return signer;
    } catch (error) {
      this.logger.error(`Failed to import wallet: ${error.message}`);
      throw new Error(`Wallet import failed: ${error.message}`);
    }
  }

  /**
   * Import wallet from secret key
   */
  async importFromSecretKey(secretKey: string): Promise<InMemorySigner> {
    try {
      this.logger.log('Importing wallet from secret key');

      const signer = await InMemorySigner.fromSecretKey(secretKey);

      const pkh = await signer.publicKeyHash();
      this.logger.log(`Wallet imported successfully: ${pkh}`);

      return signer;
    } catch (error) {
      this.logger.error(`Failed to import wallet from secret key: ${error.message}`);
      throw new Error(`Wallet import failed: ${error.message}`);
    }
  }

  /**
   * Get wallet information
   */
  async getWalletInfo(signer: InMemorySigner): Promise<WalletInfo> {
    const publicKeyHash = await signer.publicKeyHash();
    const publicKey = await signer.publicKey();

    return {
      publicKeyHash,
      publicKey,
    };
  }

  /**
   * Get public key hash
   */
  async getPublicKeyHash(signer: InMemorySigner): Promise<string> {
    return await signer.publicKeyHash();
  }

  /**
   * Validate Tezos address
   */
  validateAddress(address: string): boolean {
    // First check with our regex patterns
    if (!isValidTezosAddress(address)) {
      return false;
    }

    // Then use Taquito's validator for additional checks
    try {
      const result: ValidationResult = validateAddress(address);
      return result === 3; // ValidationResult.VALID
    } catch (error) {
      return false;
    }
  }

  /**
   * Encrypt wallet with password
   * Uses AES-256-GCM with dual encryption (user password + app seed)
   */
  async encryptWallet(
    secretKey: string,
    userPassword: string,
    appSeed?: string,
  ): Promise<EncryptedWallet> {
    try {
      this.logger.log('Encrypting wallet');

      // Generate random salt
      const salt = crypto.randomBytes(this.SALT_LENGTH);

      // Derive encryption key from password + optional app seed
      const passwordWithSeed = appSeed
        ? `${userPassword}:${appSeed}`
        : userPassword;

      const key = crypto.scryptSync(
        passwordWithSeed,
        salt,
        this.KEY_LENGTH,
      );

      // Generate random IV
      const iv = crypto.randomBytes(this.IV_LENGTH);

      // Create cipher
      const cipher = crypto.createCipheriv(
        this.ENCRYPTION_ALGORITHM,
        key,
        iv,
      );

      // Encrypt the secret key
      let encrypted = cipher.update(secretKey, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Get authentication tag
      const tag = cipher.getAuthTag();

      // Clear sensitive data from memory
      key.fill(0);

      return {
        ciphertext: encrypted,
        iv: iv.toString('hex'),
        salt: salt.toString('hex'),
        tag: tag.toString('hex'),
      };
    } catch (error) {
      this.logger.error(`Wallet encryption failed: ${error.message}`);
      throw new Error(`Wallet encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt wallet with password
   */
  async decryptWallet(
    encrypted: EncryptedWallet,
    userPassword: string,
    appSeed?: string,
  ): Promise<string> {
    try {
      this.logger.log('Decrypting wallet');

      // Reconstruct key from password + optional app seed
      const passwordWithSeed = appSeed
        ? `${userPassword}:${appSeed}`
        : userPassword;

      const key = crypto.scryptSync(
        passwordWithSeed,
        Buffer.from(encrypted.salt, 'hex'),
        this.KEY_LENGTH,
      );

      // Create decipher
      const decipher = crypto.createDecipheriv(
        this.ENCRYPTION_ALGORITHM,
        key,
        Buffer.from(encrypted.iv, 'hex'),
      );

      // Set authentication tag
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));

      // Decrypt
      let decrypted = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      // Clear sensitive data from memory
      key.fill(0);

      return decrypted;
    } catch (error) {
      this.logger.error(`Wallet decryption failed: ${error.message}`);
      throw new Error('Invalid password or corrupted wallet data');
    }
  }

  /**
   * Sign operation with wallet
   */
  async signOperation(
    signer: InMemorySigner,
    operation: any,
  ): Promise<string> {
    try {
      this.logger.log('Signing operation');

      // Sign the operation bytes
      const signed = await signer.sign(operation);

      this.logger.log('Operation signed successfully');
      return signed.sig;
    } catch (error) {
      this.logger.error(`Operation signing failed: ${error.message}`);
      throw new Error(`Operation signing failed: ${error.message}`);
    }
  }

  /**
   * Generate new mnemonic
   */
  generateMnemonic(): string {
    // Use Taquito's mnemonic generation
    const mnemonic = InMemorySigner.generateMnemonic();
    this.logger.log('New mnemonic generated');
    return mnemonic;
  }

  /**
   * Hash password with bcrypt
   */
  async hashPassword(password: string, salt?: string): Promise<string> {
    const saltToUse = salt || await bcrypt.genSalt(10);
    return await bcrypt.hash(password, saltToUse);
  }

  /**
   * Verify password hash
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return await bcrypt.compare(password, hash);
  }

  /**
   * Generate random salt for password hashing
   */
  generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Securely clear sensitive string from memory
   */
  clearSensitiveData(data: string): void {
    // Overwrite the string content in memory
    // Note: This is a best-effort approach as JavaScript doesn't
    // give us direct memory control
    try {
      // Fill with zeros
      for (let i = 0; i < data.length; i++) {
        // @ts-ignore - We're intentionally modifying the string
        data[i] = '\0';
      }
    } catch (error) {
      // String is immutable, this is expected
      this.logger.debug('Could not clear sensitive data (expected for immutable strings)');
    }
  }

  /**
   * Validate mnemonic format
   */
  validateMnemonic(mnemonic: string): boolean {
    try {
      const words = mnemonic.trim().split(/\s+/);
      // BIP39 mnemonics are 12, 15, 18, 21, or 24 words
      return [12, 15, 18, 21, 24].includes(words.length);
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate secret key format
   */
  validateSecretKey(secretKey: string): boolean {
    try {
      // Tezos secret keys start with 'edsk', 'spsk', or 'p2sk'
      return /^(edsk|spsk|p2sk)[1-9A-HJ-NP-Za-km-z]{50,}$/.test(secretKey);
    } catch (error) {
      return false;
    }
  }
}
