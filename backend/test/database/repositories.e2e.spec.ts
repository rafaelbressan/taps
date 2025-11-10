import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { DatabaseModule } from '../../src/database/database.module';
import {
  SettingsRepository,
  PaymentsRepository,
  DelegatorsPaymentsRepository,
  DelegatorsFeeRepository,
  BondPoolRepository,
} from '../../src/database/repositories';
import { ConfigModule } from '../../src/config/config.module';

/**
 * End-to-end tests for repositories
 * Note: These tests require a running PostgreSQL database
 * Run with: npm run test:e2e
 */
describe('Repositories E2E Tests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let settingsRepo: SettingsRepository;
  let paymentsRepo: PaymentsRepository;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);
    settingsRepo = app.get<SettingsRepository>(SettingsRepository);
    paymentsRepo = app.get<PaymentsRepository>(PaymentsRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('SettingsRepository', () => {
    const testBakerId = 'tz1test123e2e';

    afterEach(async () => {
      // Cleanup
      try {
        await settingsRepo.delete(testBakerId);
      } catch (error) {
        // Ignore if not found
      }
    });

    it('should create and retrieve settings', async () => {
      const createDto = {
        bakerId: testBakerId,
        defaultFee: 5.0,
        updateFreq: 300,
        applicationPort: 3000,
        provider: 'https://rpc.ghostnet.teztnets.xyz',
        blockExplorer: 'https://ghostnet.tzkt.io',
      };

      const created = await settingsRepo.create(createDto);
      expect(created.bakerId).toBe(testBakerId);

      const found = await settingsRepo.findByBakerId(testBakerId);
      expect(found).toBeDefined();
      expect(found?.bakerId).toBe(testBakerId);
    });

    it('should update settings', async () => {
      const createDto = {
        bakerId: testBakerId,
        defaultFee: 5.0,
        updateFreq: 300,
        applicationPort: 3000,
        provider: 'https://rpc.ghostnet.teztnets.xyz',
        blockExplorer: 'https://ghostnet.tzkt.io',
      };

      await settingsRepo.create(createDto);

      const updated = await settingsRepo.update(testBakerId, {
        defaultFee: 7.5,
      });

      expect(updated.defaultFee.toNumber()).toBe(7.5);
    });
  });

  describe('PaymentsRepository', () => {
    const testBakerId = 'tz1test123e2e';

    beforeAll(async () => {
      // Create settings first (required for foreign key)
      try {
        await settingsRepo.create({
          bakerId: testBakerId,
          defaultFee: 5.0,
          updateFreq: 300,
          applicationPort: 3000,
          provider: 'https://rpc.ghostnet.teztnets.xyz',
          blockExplorer: 'https://ghostnet.tzkt.io',
        });
      } catch (error) {
        // Settings might already exist
      }
    });

    afterAll(async () => {
      // Cleanup
      try {
        await settingsRepo.delete(testBakerId);
      } catch (error) {
        // Ignore if not found
      }
    });

    it('should create and retrieve payment', async () => {
      const createDto = {
        bakerId: testBakerId,
        cycle: 600,
        date: new Date().toISOString(),
        result: 'paid' as any,
        total: 125.5,
        transactionHash: 'oo1teste2e123',
      };

      const created = await paymentsRepo.create(createDto);
      expect(created.bakerId).toBe(testBakerId);
      expect(created.cycle).toBe(600);

      const found = await paymentsRepo.findByBakerAndCycle(testBakerId, 600);
      expect(found.length).toBeGreaterThan(0);
    });
  });

  describe('Repository Integration', () => {
    it('should have all repositories available', () => {
      expect(settingsRepo).toBeDefined();
      expect(paymentsRepo).toBeDefined();
      expect(app.get(DelegatorsPaymentsRepository)).toBeDefined();
      expect(app.get(DelegatorsFeeRepository)).toBeDefined();
      expect(app.get(BondPoolRepository)).toBeDefined();
    });
  });
});
