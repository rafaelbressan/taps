import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SettingsEntity } from '../../shared/entities';
import {
  CreateSettingsDto,
  UpdateSettingsDto,
} from '../../shared/dto';
import { Prisma } from '@prisma/client';

/**
 * Repository for Settings operations
 */
@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create new settings for a baker
   */
  async create(data: CreateSettingsDto): Promise<SettingsEntity> {
    const settings = await this.prisma.settings.create({
      data: {
        bakerId: data.bakerId,
        defaultFee: new Prisma.Decimal(data.defaultFee),
        updateFreq: data.updateFreq,
        userName: data.userName,
        passHash: data.passHash,
        applicationPort: data.applicationPort,
        mode: data.mode,
        hashSalt: data.hashSalt,
        walletHash: data.walletHash,
        walletSalt: data.walletSalt,
        encryptedPassphrase: data.encryptedPassphrase,
        appPassphrase: data.appPassphrase,
        delegate: data.delegate,
        proxyServer: data.proxyServer,
        proxyPort: data.proxyPort ?? 80,
        provider: data.provider,
        gasLimit: data.gasLimit ?? 15400,
        storageLimit: data.storageLimit ?? 300,
        transactionFee: data.transactionFee
          ? new Prisma.Decimal(data.transactionFee)
          : new Prisma.Decimal(0.0018),
        blockExplorer: data.blockExplorer,
        numBlocksWait: data.numBlocksWait ?? 8,
        paymentRetries: data.paymentRetries ?? 1,
        minBetweenRetries: data.minBetweenRetries ?? 1,
      },
    });

    return new SettingsEntity(settings);
  }

  /**
   * Find settings by baker ID
   */
  async findByBakerId(bakerId: string): Promise<SettingsEntity | null> {
    const settings = await this.prisma.settings.findUnique({
      where: { bakerId },
    });

    return settings ? new SettingsEntity(settings) : null;
  }

  /**
   * Find settings by baker ID or throw
   */
  async findByBakerIdOrThrow(bakerId: string): Promise<SettingsEntity> {
    const settings = await this.findByBakerId(bakerId);

    if (!settings) {
      throw new NotFoundException(
        `Settings not found for baker ID: ${bakerId}`,
      );
    }

    return settings;
  }

  /**
   * Find all settings
   */
  async findAll(): Promise<SettingsEntity[]> {
    const settings = await this.prisma.settings.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return settings.map((s) => new SettingsEntity(s));
  }

  /**
   * Update settings for a baker
   */
  async update(
    bakerId: string,
    data: UpdateSettingsDto,
  ): Promise<SettingsEntity> {
    const updateData: Prisma.SettingsUpdateInput = {};

    if (data.defaultFee !== undefined) {
      updateData.defaultFee = new Prisma.Decimal(data.defaultFee);
    }
    if (data.updateFreq !== undefined) {
      updateData.updateFreq = data.updateFreq;
    }
    if (data.userName !== undefined) {
      updateData.userName = data.userName;
    }
    if (data.passHash !== undefined) {
      updateData.passHash = data.passHash;
    }
    if (data.applicationPort !== undefined) {
      updateData.applicationPort = data.applicationPort;
    }
    if (data.mode !== undefined) {
      updateData.mode = data.mode;
    }
    if (data.hashSalt !== undefined) {
      updateData.hashSalt = data.hashSalt;
    }
    if (data.walletHash !== undefined) {
      updateData.walletHash = data.walletHash;
    }
    if (data.walletSalt !== undefined) {
      updateData.walletSalt = data.walletSalt;
    }
    if (data.encryptedPassphrase !== undefined) {
      updateData.encryptedPassphrase = data.encryptedPassphrase;
    }
    if (data.appPassphrase !== undefined) {
      updateData.appPassphrase = data.appPassphrase;
    }
    if (data.delegate !== undefined) {
      updateData.delegate = data.delegate;
    }
    if (data.proxyServer !== undefined) {
      updateData.proxyServer = data.proxyServer;
    }
    if (data.proxyPort !== undefined) {
      updateData.proxyPort = data.proxyPort;
    }
    if (data.provider !== undefined) {
      updateData.provider = data.provider;
    }
    if (data.gasLimit !== undefined) {
      updateData.gasLimit = data.gasLimit;
    }
    if (data.storageLimit !== undefined) {
      updateData.storageLimit = data.storageLimit;
    }
    if (data.transactionFee !== undefined) {
      updateData.transactionFee = new Prisma.Decimal(data.transactionFee);
    }
    if (data.blockExplorer !== undefined) {
      updateData.blockExplorer = data.blockExplorer;
    }
    if (data.numBlocksWait !== undefined) {
      updateData.numBlocksWait = data.numBlocksWait;
    }
    if (data.paymentRetries !== undefined) {
      updateData.paymentRetries = data.paymentRetries;
    }
    if (data.minBetweenRetries !== undefined) {
      updateData.minBetweenRetries = data.minBetweenRetries;
    }

    const settings = await this.prisma.settings.update({
      where: { bakerId },
      data: updateData,
    });

    return new SettingsEntity(settings);
  }

  /**
   * Delete settings for a baker
   */
  async delete(bakerId: string): Promise<void> {
    await this.prisma.settings.delete({
      where: { bakerId },
    });
  }

  /**
   * Check if settings exist for a baker
   */
  async exists(bakerId: string): Promise<boolean> {
    const count = await this.prisma.settings.count({
      where: { bakerId },
    });

    return count > 0;
  }

  /**
   * Find settings by operation mode
   */
  async findByMode(mode: string): Promise<SettingsEntity[]> {
    const settings = await this.prisma.settings.findMany({
      where: { mode: mode as any },
      orderBy: { createdAt: 'desc' },
    });

    return settings.map((s) => new SettingsEntity(s));
  }

  /**
   * Count total settings
   */
  async count(): Promise<number> {
    return this.prisma.settings.count();
  }
}
