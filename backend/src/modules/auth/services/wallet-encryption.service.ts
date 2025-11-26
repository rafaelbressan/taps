import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Encrypted wallet structure
 */
export interface EncryptedWallet {
  phrase: string; // Encrypted with user password
  appPhrase: string; // Encrypted with app seed
  walletHash: string; // Hash for verification
  walletSalt: string; // Salt for hash
}

/**
 * Wallet Encryption Service
 *
 * Handles wallet passphrase encryption using dual encryption
 * Based on BUSINESS_LOGIC.md: "Dual Encryption System"
 *
 * ColdFusion logic:
 * 1. encrypt(phrase, userPassword, 'AES', 'Hex')
 * 2. encrypt(encrypted1, appSeed, 'AES', 'Hex')
 * 3. hash(passphrase & wallet_salt, 'SHA-512')
 */
@Injectable()
export class WalletEncryptionService {
  private readonly logger = new Logger(WalletEncryptionService.name);
  private readonly ALGORITHM = 'aes-256-cbc';
  private readonly KEY_LENGTH = 32; // 256 bits
  private readonly IV_LENGTH = 16;

  /**
   * Dual encryption matching current system:
   * 1. Encrypt with user password
   * 2. Encrypt with app seed
   *
   * Replaces ColdFusion:
   * encrypt(phrase, userPassword, 'AES', 'Hex')
   * encrypt(encrypted1, appSeed, 'AES', 'Hex')
   */
  async encryptWalletPassphrase(
    passphrase: string,
    userPassword: string,
    appSeed?: string,
  ): Promise<EncryptedWallet> {
    try {
      this.logger.debug('Encrypting wallet passphrase with dual encryption');

      // Step 1: Generate salt for hash
      const walletSalt = crypto.randomBytes(32).toString('hex');

      // Step 2: Hash passphrase for verification (SHA-512)
      const walletHash = this.hashWalletPassphrase(passphrase, walletSalt);

      // Step 3: Encrypt with user password
      const encrypted1 = await this.encryptWithKey(passphrase, userPassword);

      // Step 4: Encrypt with app seed (if provided)
      let encrypted2 = encrypted1;
      if (appSeed) {
        encrypted2 = await this.encryptWithKey(encrypted1, appSeed);
      }

      return {
        phrase: encrypted1, // Encrypted with user password
        appPhrase: encrypted2, // Encrypted with app seed
        walletHash,
        walletSalt,
      };
    } catch (error) {
      this.logger.error(`Wallet encryption failed: ${error.message}`);
      throw new Error(`Wallet encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt wallet passphrase
   * Reverses dual encryption
   */
  async decryptWalletPassphrase(
    encrypted: EncryptedWallet,
    userPassword: string,
    appSeed?: string,
  ): Promise<string> {
    try {
      this.logger.debug('Decrypting wallet passphrase');

      // Step 1: Decrypt with app seed (if provided)
      let decrypted1 = encrypted.appPhrase;
      if (appSeed && encrypted.appPhrase !== encrypted.phrase) {
        decrypted1 = await this.decryptWithKey(encrypted.appPhrase, appSeed);
      } else {
        decrypted1 = encrypted.phrase;
      }

      // Step 2: Decrypt with user password
      const passphrase = await this.decryptWithKey(decrypted1, userPassword);

      // Step 3: Verify hash
      const isValid = this.verifyWalletPassphrase(
        passphrase,
        encrypted.walletHash,
        encrypted.walletSalt,
      );

      if (!isValid) {
        throw new Error('Passphrase verification failed');
      }

      return passphrase;
    } catch (error) {
      this.logger.error(`Wallet decryption failed: ${error.message}`);
      throw new Error('Invalid password or corrupted wallet data');
    }
  }

  /**
   * Hash wallet passphrase for verification
   * Replaces: hash(passphrase & wallet_salt, 'SHA-512')
   */
  hashWalletPassphrase(passphrase: string, salt: string): string {
    const combined = passphrase + salt;
    return crypto
      .createHash('sha512')
      .update(combined)
      .digest('hex')
      .toUpperCase();
  }

  /**
   * Verify wallet passphrase against stored hash
   */
  verifyWalletPassphrase(
    passphrase: string,
    hash: string,
    salt: string,
  ): boolean {
    const computedHash = this.hashWalletPassphrase(passphrase, salt);
    return computedHash === hash.toUpperCase();
  }

  /**
   * Encrypt data with key (AES-256-CBC)
   * Simulates ColdFusion's encrypt(data, key, 'AES', 'Hex')
   */
  private async encryptWithKey(
    data: string,
    password: string,
  ): Promise<string> {
    // Derive key from password
    const key = crypto.scryptSync(password, 'salt', this.KEY_LENGTH);

    // Generate random IV
    const iv = crypto.randomBytes(this.IV_LENGTH);

    // Encrypt
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Return IV + encrypted data (hex format)
    return iv.toString('hex') + ':' + encrypted;
  }

  /**
   * Decrypt data with key (AES-256-CBC)
   */
  private async decryptWithKey(
    encryptedData: string,
    password: string,
  ): Promise<string> {
    // Split IV and encrypted data
    const parts = encryptedData.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];

    // Derive key from password
    const key = crypto.scryptSync(password, 'salt', this.KEY_LENGTH);

    // Decrypt
    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Generate random salt
   */
  generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
