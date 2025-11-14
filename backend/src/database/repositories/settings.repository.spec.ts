import { Test, TestingModule } from '@nestjs/testing';
import { SettingsRepository } from './settings.repository';
import { PrismaService } from '../prisma.service';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('SettingsRepository', () => {
  let repository: SettingsRepository;
  let prismaService: PrismaService;

  const mockPrismaService = {
    settings: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockSettings = {
    bakerId: 'tz1abc123',
    defaultFee: new Prisma.Decimal(5.0),
    updateFreq: 300,
    userName: 'admin',
    passHash: 'hashed_password',
    applicationPort: 3000,
    mode: 'simulation',
    hashSalt: 'salt',
    walletHash: 'wallet_hash',
    walletSalt: 'wallet_salt',
    encryptedPassphrase: 'encrypted',
    appPassphrase: 'app_pass',
    delegate: '',
    proxyServer: '',
    proxyPort: 80,
    provider: 'https://rpc.ghostnet.teztnets.xyz',
    gasLimit: 15400,
    storageLimit: 300,
    transactionFee: new Prisma.Decimal(0.0018),
    blockExplorer: 'https://ghostnet.tzkt.io',
    numBlocksWait: 8,
    paymentRetries: 1,
    minBetweenRetries: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsRepository,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    repository = module.get<SettingsRepository>(SettingsRepository);
    prismaService = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  describe('create', () => {
    it('should create new settings', async () => {
      mockPrismaService.settings.create.mockResolvedValue(mockSettings);

      const dto = {
        bakerId: 'tz1abc123',
        defaultFee: 5.0,
        updateFreq: 300,
        applicationPort: 3000,
        provider: 'https://rpc.ghostnet.teztnets.xyz',
        blockExplorer: 'https://ghostnet.tzkt.io',
      };

      const result = await repository.create(dto);

      expect(result.bakerId).toBe('tz1abc123');
      expect(mockPrismaService.settings.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByBakerId', () => {
    it('should return settings when found', async () => {
      mockPrismaService.settings.findUnique.mockResolvedValue(mockSettings);

      const result = await repository.findByBakerId('tz1abc123');

      expect(result).toBeDefined();
      expect(result?.bakerId).toBe('tz1abc123');
      expect(mockPrismaService.settings.findUnique).toHaveBeenCalledWith({
        where: { bakerId: 'tz1abc123' },
      });
    });

    it('should return null when not found', async () => {
      mockPrismaService.settings.findUnique.mockResolvedValue(null);

      const result = await repository.findByBakerId('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByBakerIdOrThrow', () => {
    it('should return settings when found', async () => {
      mockPrismaService.settings.findUnique.mockResolvedValue(mockSettings);

      const result = await repository.findByBakerIdOrThrow('tz1abc123');

      expect(result).toBeDefined();
      expect(result.bakerId).toBe('tz1abc123');
    });

    it('should throw NotFoundException when not found', async () => {
      mockPrismaService.settings.findUnique.mockResolvedValue(null);

      await expect(
        repository.findByBakerIdOrThrow('nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should return all settings', async () => {
      mockPrismaService.settings.findMany.mockResolvedValue([mockSettings]);

      const result = await repository.findAll();

      expect(result).toHaveLength(1);
      expect(result[0].bakerId).toBe('tz1abc123');
    });

    it('should return empty array when no settings exist', async () => {
      mockPrismaService.settings.findMany.mockResolvedValue([]);

      const result = await repository.findAll();

      expect(result).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('should update settings', async () => {
      const updatedSettings = { ...mockSettings, defaultFee: new Prisma.Decimal(7.5) };
      mockPrismaService.settings.update.mockResolvedValue(updatedSettings);

      const result = await repository.update('tz1abc123', { defaultFee: 7.5 });

      expect(result.defaultFee.toNumber()).toBe(7.5);
      expect(mockPrismaService.settings.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('should delete settings', async () => {
      mockPrismaService.settings.delete.mockResolvedValue(mockSettings);

      await repository.delete('tz1abc123');

      expect(mockPrismaService.settings.delete).toHaveBeenCalledWith({
        where: { bakerId: 'tz1abc123' },
      });
    });
  });

  describe('exists', () => {
    it('should return true when settings exist', async () => {
      mockPrismaService.settings.count.mockResolvedValue(1);

      const result = await repository.exists('tz1abc123');

      expect(result).toBe(true);
    });

    it('should return false when settings do not exist', async () => {
      mockPrismaService.settings.count.mockResolvedValue(0);

      const result = await repository.exists('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('findByMode', () => {
    it('should find settings by operation mode', async () => {
      mockPrismaService.settings.findMany.mockResolvedValue([mockSettings]);

      const result = await repository.findByMode('simulation');

      expect(result).toHaveLength(1);
      expect(result[0].mode).toBe('simulation');
    });
  });

  describe('count', () => {
    it('should return total count of settings', async () => {
      mockPrismaService.settings.count.mockResolvedValue(5);

      const result = await repository.count();

      expect(result).toBe(5);
    });
  });
});
