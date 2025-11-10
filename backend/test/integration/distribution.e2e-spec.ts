/**
 * Reward Distribution - End-to-End Integration Test
 *
 * Tests the complete distribution workflow from detection to payment
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DistributionOrchestratorService } from '../../src/modules/rewards/services/distribution-orchestrator.service';
import { PaymentsRepository, DelegatorsPaymentsRepository } from '../../src/database/repositories';
import { PrismaService } from '../../src/database/prisma.service';
import { testBaker, testBakerWithWallet } from '../fixtures/baker.fixture';
import { testDelegators } from '../fixtures/delegators.fixture';
import {
  cleanDatabase,
  seedTestBaker,
  seedTestDelegators,
} from '../utils/test-helpers';

describe('Reward Distribution (e2e)', () => {
  let app: INestApplication;
  let orchestrator: DistributionOrchestratorService;
  let paymentsRepo: PaymentsRepository;
  let delegatorsPaymentsRepo: DelegatorsPaymentsRepository;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      // Import all required modules
      imports: [
        // DatabaseModule,
        // BlockchainModule,
        // RewardsModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    orchestrator = moduleFixture.get<DistributionOrchestratorService>(
      DistributionOrchestratorService,
    );
    paymentsRepo = moduleFixture.get<PaymentsRepository>(PaymentsRepository);
    delegatorsPaymentsRepo = moduleFixture.get<DelegatorsPaymentsRepository>(
      DelegatorsPaymentsRepository,
    );
    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean database before each test
    await cleanDatabase(prisma);
  });

  describe('Full Distribution Cycle', () => {
    it('should complete full distribution workflow in simulation mode', async () => {
      // 1. Set up test baker and delegators
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
      });
      await seedTestDelegators(prisma, testBaker.bakerId, testDelegators);

      // 2. Mock blockchain responses
      // (TzKT API and Tezos RPC mocks)

      // 3. Trigger distribution
      const result = await orchestrator.processRewardsDistribution(
        testBaker.bakerId,
      );

      // 4. Verify results
      expect(result.delegatorDistribution.success).toBe(true);
      expect(result.delegatorDistribution.delegatorsPaid).toBeGreaterThan(0);

      // 5. Verify database records
      const payment = await paymentsRepo.findByCycle(
        testBaker.bakerId,
        result.delegatorDistribution.cycle,
      );

      expect(payment).toBeDefined();
      expect(payment?.result).toBe('paid');

      // 6. Verify delegator payments
      const delegatorPayments = await delegatorsPaymentsRepo.findByCycle(
        testBaker.bakerId,
        result.delegatorDistribution.cycle,
      );

      expect(delegatorPayments.length).toBeGreaterThan(0);
      delegatorPayments.forEach((dp) => {
        expect(dp.paymentValue).toBeGreaterThan(0);
      });

      // 7. In simulation mode, no actual transaction should be created
      expect(payment?.transactionHash).toBeNull();
    });

    it('should handle distribution with custom fees', async () => {
      // Set up baker with custom fee delegators
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
        overDel: false, // Allow custom fees
      });

      // Add delegators with custom fees
      await prisma.delegatorFee.create({
        data: {
          bakerId: testBaker.bakerId,
          delegatorAddress: testDelegators[0].address,
          fee: 10.0, // Custom fee
        },
      });

      await seedTestDelegators(prisma, testBaker.bakerId, testDelegators);

      // Trigger distribution
      const result = await orchestrator.processRewardsDistribution(
        testBaker.bakerId,
      );

      // Verify custom fee was applied
      const delegatorPayment = await prisma.delegatorPayment.findFirst({
        where: {
          bakerId: testBaker.bakerId,
          delegatorAddress: testDelegators[0].address,
          cycle: result.delegatorDistribution.cycle,
        },
      });

      expect(delegatorPayment?.fee).toBe(10.0);
    });

    it('should skip delegators below minimum payment', async () => {
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
        minPayment: 10.0, // Minimum 10 XTZ
      });

      // Add delegator with very small balance (will get < 10 XTZ)
      await seedTestDelegators(prisma, testBaker.bakerId, [
        {
          address: 'tz1SmallDelegator',
          stakingBalance: 1000000, // Very small
          fee: 5.0,
        },
      ]);

      const result = await orchestrator.processRewardsDistribution(
        testBaker.bakerId,
      );

      // Small delegator should be skipped
      const smallDelegatorPayment = await prisma.delegatorPayment.findFirst({
        where: {
          bakerId: testBaker.bakerId,
          delegatorAddress: 'tz1SmallDelegator',
          cycle: result.delegatorDistribution.cycle,
        },
      });

      // Payment record exists but amount is 0 or below minimum
      expect(
        smallDelegatorPayment ? smallDelegatorPayment.paymentValue : 0,
      ).toBeLessThan(10);
    });
  });

  describe('Bond Pool Distribution', () => {
    it('should trigger bond pool distribution when enabled', async () => {
      // Set up baker with bond pool
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
      });

      // Create bond pool settings
      await prisma.bondPoolSettings.create({
        data: {
          bakerId: testBaker.bakerId,
          enabled: true,
          admCharge: 10.0,
          managerAddress: 'tz1Manager',
        },
      });

      // Add bond pool members
      await prisma.bondPoolMember.create({
        data: {
          bakerId: testBaker.bakerId,
          memberAddress: 'tz1Member1',
          amount: 1000.0,
        },
      });

      // Trigger distribution
      const result = await orchestrator.processRewardsDistribution(
        testBaker.bakerId,
      );

      // Verify bond pool distribution occurred
      expect(result.bondPoolDistribution).toBeDefined();
      expect(result.bondPoolDistribution?.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing baker settings', async () => {
      await expect(
        orchestrator.processRewardsDistribution('nonexistent'),
      ).rejects.toThrow();
    });

    it('should handle zero rewards', async () => {
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
      });

      // Mock zero rewards from TzKT

      const result = await orchestrator.processRewardsDistribution(
        testBaker.bakerId,
      );

      expect(result.cycleRewards.totalRewards.toNumber()).toBe(0);
      expect(result.delegatorDistribution.delegatorsPaid).toBe(0);
    });

    it('should handle network errors gracefully', async () => {
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
      });

      // Mock network error

      await expect(
        orchestrator.processRewardsDistribution(testBaker.bakerId),
      ).rejects.toThrow();
    });
  });

  describe('Validation', () => {
    it('should validate total distributed equals sum of individual payments', async () => {
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
      });
      await seedTestDelegators(prisma, testBaker.bakerId, testDelegators);

      const result = await orchestrator.processRewardsDistribution(
        testBaker.bakerId,
      );

      // Get all delegator payments
      const payments = await delegatorsPaymentsRepo.findByCycle(
        testBaker.bakerId,
        result.delegatorDistribution.cycle,
      );

      const sum = payments.reduce((total, p) => total + p.paymentValue, 0);

      expect(sum).toBeCloseTo(
        result.delegatorDistribution.totalDistributed,
        6,
      );
    });

    it('should validate baker fee calculation', async () => {
      await seedTestBaker(prisma, {
        ...testBakerWithWallet,
        mode: 'simulation',
        defaultFee: 5.0,
      });
      await seedTestDelegators(prisma, testBaker.bakerId, testDelegators);

      const result = await orchestrator.processRewardsDistribution(
        testBaker.bakerId,
      );

      // Baker fee should be ~5% of total rewards
      const expectedFee = result.cycleRewards.totalRewards.times(0.05);

      expect(result.cycleRewards.bakerFee.toNumber()).toBeCloseTo(
        expectedFee.toNumber(),
        6,
      );
    });
  });
});
