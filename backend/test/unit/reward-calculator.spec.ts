/**
 * Reward Calculator Service - Comprehensive Unit Tests
 *
 * Tests the core reward calculation algorithm against BUSINESS_LOGIC.md examples
 */

import { Test, TestingModule } from '@nestjs/testing';
import { RewardCalculatorService } from '../../src/modules/rewards/services/reward-calculator.service';
import { SettingsRepository, DelegatorsFeeRepository } from '../../src/database/repositories';
import { TzKTClientService } from '../../src/modules/blockchain/services/tzkt-client.service';
import Decimal from 'decimal.js';

describe('RewardCalculatorService', () => {
  let service: RewardCalculatorService;
  let settingsRepo: jest.Mocked<SettingsRepository>;
  let delegatorsFeeRepo: jest.Mocked<DelegatorsFeeRepository>;
  let tzktClient: jest.Mocked<TzKTClientService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardCalculatorService,
        {
          provide: SettingsRepository,
          useValue: {
            findByBakerId: jest.fn(),
          },
        },
        {
          provide: DelegatorsFeeRepository,
          useValue: {
            findByDelegatorAndBaker: jest.fn(),
          },
        },
        {
          provide: TzKTClientService,
          useValue: {
            getBakerRewards: jest.fn(),
            getDelegators: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RewardCalculatorService>(RewardCalculatorService);
    settingsRepo = module.get(SettingsRepository);
    delegatorsFeeRepo = module.get(DelegatorsFeeRepository);
    tzktClient = module.get(TzKTClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateDelegatorReward', () => {
    /**
     * Test Case from BUSINESS_LOGIC.md Section 1.2 Example 1:
     * Rewards: 5,432,100 mutez
     * Fee: 5%
     * Expected: 5.160495 XTZ
     */
    it('should calculate reward correctly - Example 1 from BUSINESS_LOGIC.md', () => {
      const rewardsMutez = 5432100;
      const fee = 5;

      const result = service['calculateRewardWithFee'](rewardsMutez, fee);

      expect(result.toString()).toBe('5.160495');
    });

    /**
     * Test Case from BUSINESS_LOGIC.md Section 1.2 Example 2:
     * Rewards: 1,000,000 mutez
     * Fee: 10%
     * Expected: 0.90 XTZ
     */
    it('should calculate reward correctly - Example 2 from BUSINESS_LOGIC.md', () => {
      const rewardsMutez = 1000000;
      const fee = 10;

      const result = service['calculateRewardWithFee'](rewardsMutez, fee);

      expect(result.toString()).toBe('0.9');
    });

    /**
     * Test zero rewards
     */
    it('should handle zero rewards', () => {
      const result = service['calculateRewardWithFee'](0, 5);

      expect(result.toString()).toBe('0');
    });

    /**
     * Test 100% fee (baker keeps all)
     */
    it('should handle 100% fee', () => {
      const result = service['calculateRewardWithFee'](1000000, 100);

      expect(result.toString()).toBe('0');
    });

    /**
     * Test 0% fee (delegator gets all)
     */
    it('should handle 0% fee', () => {
      const result = service['calculateRewardWithFee'](1000000, 0);

      expect(result.toString()).toBe('1');
    });

    /**
     * Test precision with large numbers
     */
    it('should maintain 6 decimal precision for large rewards', () => {
      const rewardsMutez = 999999999; // 999.999999 XTZ
      const fee = 5;

      const result = service['calculateRewardWithFee'](rewardsMutez, fee);

      // Should be 949.999999 (95% of 999.999999)
      expect(result.toString()).toBe('949.999999');
    });

    /**
     * Test precision with very small numbers
     */
    it('should maintain precision for small rewards', () => {
      const rewardsMutez = 1; // 0.000001 XTZ
      const fee = 5;

      const result = service['calculateRewardWithFee'](rewardsMutez, fee);

      expect(result.toNumber()).toBeGreaterThan(0);
    });

    /**
     * Test various fee percentages
     */
    it.each([
      [1000000, 1, 0.99],
      [1000000, 25, 0.75],
      [1000000, 50, 0.5],
      [1000000, 75, 0.25],
      [1000000, 99, 0.01],
    ])('should calculate correctly for %i mutez with %i%% fee', (rewards, fee, expected) => {
      const result = service['calculateRewardWithFee'](rewards, fee);

      expect(result.toNumber()).toBeCloseTo(expected, 6);
    });
  });

  describe('calculateCycleRewards', () => {
    const mockSettings = {
      bakerId: 'tz1Baker',
      defaultFee: 5,
      overDel: false,
    };

    const mockBakerRewards = {
      cycle: 500,
      stakingBalance: 17000000000, // 17,000 XTZ
      delegatedBalance: 15000000000, // 15,000 XTZ (excludes baker's 2,000 XTZ)
      rewards: 100000000, // 100 XTZ total rewards
    };

    const mockDelegators = [
      {
        address: 'tz1Delegator1',
        stakingBalance: 10000000000, // 10,000 XTZ (66.67% of delegated)
      },
      {
        address: 'tz1Delegator2',
        stakingBalance: 5000000000, // 5,000 XTZ (33.33% of delegated)
      },
    ];

    beforeEach(() => {
      settingsRepo.findByBakerId.mockResolvedValue(mockSettings as any);
      tzktClient.getBakerRewards.mockResolvedValue(mockBakerRewards);
      tzktClient.getDelegators.mockResolvedValue(mockDelegators);
      delegatorsFeeRepo.findByDelegatorAndBaker.mockResolvedValue(null);
    });

    it('should calculate rewards for all delegators', async () => {
      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      expect(result.delegatorRewards).toHaveLength(2);

      // Delegator 1 should get 66.67% of rewards with 5% fee
      const delegator1Reward = result.delegatorRewards.find(
        (r) => r.delegatorAddress === 'tz1Delegator1',
      );
      expect(delegator1Reward).toBeDefined();
      expect(delegator1Reward!.netReward.toNumber()).toBeCloseTo(63.333, 3);

      // Delegator 2 should get 33.33% of rewards with 5% fee
      const delegator2Reward = result.delegatorRewards.find(
        (r) => r.delegatorAddress === 'tz1Delegator2',
      );
      expect(delegator2Reward).toBeDefined();
      expect(delegator2Reward!.netReward.toNumber()).toBeCloseTo(31.667, 3);
    });

    it('should apply custom fees when overDel is false', async () => {
      // Mock custom fee for delegator 1
      delegatorsFeeRepo.findByDelegatorAndBaker.mockResolvedValueOnce({
        fee: 10, // Custom 10% fee
      } as any);

      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      const delegator1 = result.delegatorRewards.find(
        (r) => r.delegatorAddress === 'tz1Delegator1',
      );

      // With 10% fee, delegator should get 60 XTZ (instead of 63.333)
      expect(delegator1!.netReward.toNumber()).toBeCloseTo(60, 3);
    });

    it('should override custom fees when overDel is true', async () => {
      settingsRepo.findByBakerId.mockResolvedValue({
        ...mockSettings,
        overDel: true,
      } as any);

      delegatorsFeeRepo.findByDelegatorAndBaker.mockResolvedValue({
        fee: 10,
      } as any);

      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      // All delegators should use default fee (5%) even if they have custom fees
      result.delegatorRewards.forEach((reward) => {
        expect(reward.fee).toBe(5);
      });
    });

    it('should handle single delegator', async () => {
      tzktClient.getDelegators.mockResolvedValue([mockDelegators[0]]);

      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      expect(result.delegatorRewards).toHaveLength(1);
      // Single delegator gets all rewards (with fee)
      expect(result.delegatorRewards[0].netReward.toNumber()).toBeCloseTo(95, 3);
    });

    it('should handle zero rewards', async () => {
      tzktClient.getBakerRewards.mockResolvedValue({
        ...mockBakerRewards,
        rewards: 0,
      });

      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      result.delegatorRewards.forEach((reward) => {
        expect(reward.netReward.toNumber()).toBe(0);
      });
    });

    it('should calculate total rewards correctly', async () => {
      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      // Total should be sum of all delegator rewards
      const total = result.delegatorRewards.reduce(
        (sum, r) => sum.plus(r.netReward),
        new Decimal(0),
      );

      expect(result.totalRewards.toString()).toBe(total.toString());
    });

    it('should calculate baker fee correctly', async () => {
      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      // Baker fee is 5% of 100 XTZ = 5 XTZ
      expect(result.bakerFee.toNumber()).toBeCloseTo(5, 3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle delegators with zero balance', async () => {
      settingsRepo.findByBakerId.mockResolvedValue({
        bakerId: 'tz1Baker',
        defaultFee: 5,
        overDel: false,
      } as any);

      tzktClient.getBakerRewards.mockResolvedValue({
        cycle: 500,
        stakingBalance: 10000000000,
        delegatedBalance: 10000000000,
        rewards: 100000000,
      });

      tzktClient.getDelegators.mockResolvedValue([
        {
          address: 'tz1Active',
          stakingBalance: 10000000000,
        },
        {
          address: 'tz1Inactive',
          stakingBalance: 0, // Zero balance
        },
      ]);

      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      // Should only calculate for active delegator
      const inactiveReward = result.delegatorRewards.find(
        (r) => r.delegatorAddress === 'tz1Inactive',
      );

      expect(inactiveReward?.netReward.toNumber()).toBe(0);
    });

    it('should handle very large staking balances', async () => {
      settingsRepo.findByBakerId.mockResolvedValue({
        bakerId: 'tz1Baker',
        defaultFee: 5,
        overDel: false,
      } as any);

      const largeBalance = 1000000000000000; // 1 billion XTZ

      tzktClient.getBakerRewards.mockResolvedValue({
        cycle: 500,
        stakingBalance: largeBalance,
        delegatedBalance: largeBalance,
        rewards: 1000000000000, // 1 million XTZ rewards
      });

      tzktClient.getDelegators.mockResolvedValue([
        {
          address: 'tz1Whale',
          stakingBalance: largeBalance,
        },
      ]);

      const result = await service.calculateCycleRewards({
        bakerId: 'tz1Baker',
        cycle: 500,
      });

      // Should handle large numbers without precision loss
      expect(result.delegatorRewards[0].netReward.toNumber()).toBeGreaterThan(900000);
    });
  });
});
