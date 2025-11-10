import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { WalletEncryptionService } from '../services/wallet-encryption.service';
import { SettingsRepository } from '../../../database/repositories';

/**
 * Wallet Auth Guard
 *
 * Verify wallet passphrase for sensitive operations
 * Matches current system's wallet_hash verification
 */
@Injectable()
export class WalletAuthGuard implements CanActivate {
  private readonly logger = new Logger(WalletAuthGuard.name);

  constructor(
    private readonly walletEncryption: WalletEncryptionService,
    private readonly settingsRepo: SettingsRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user; // From JWT
    const passphrase = request.body?.passphrase;

    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }

    if (!passphrase) {
      throw new UnauthorizedException('Wallet passphrase required');
    }

    // Get user settings
    const settings = await this.settingsRepo.findByBakerId(user.sub);

    if (!settings) {
      throw new UnauthorizedException('User not found');
    }

    // Verify wallet passphrase
    if (!settings.walletHash || !settings.walletSalt) {
      throw new UnauthorizedException('Wallet not configured');
    }

    const isValid = this.walletEncryption.verifyWalletPassphrase(
      passphrase,
      settings.walletHash,
      settings.walletSalt,
    );

    if (!isValid) {
      this.logger.warn(`Invalid wallet passphrase attempt for user: ${user.username}`);
      throw new UnauthorizedException('Invalid wallet passphrase');
    }

    this.logger.log(`Wallet passphrase verified for user: ${user.username}`);
    return true;
  }
}
