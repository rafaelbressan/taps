import { Test, TestingModule } from '@nestjs/testing';
import { RewardCalculatorService } from './reward-calculator.service';
import { TzKTClientService } from '../../blockchain/services/tzkt-client.service';
import { SettingsRepository, DelegatorsFeeRepository } from '../../../database/repositories';
import Decimal from 'decimal.js';

describe('RewardCalculatorService', () => {
  let service: RewardCalculatorService;
  let tzktClient: TzKTClientService;
  let settingsRepo: SettingsRepository;
  let delegatorsFeeRepo: DelegatorsFeeRepository;

  const mockTzKTClient = {
    getRewardSplit: jest.fn(),
  };

  const mockSettingsRepo = {
    findByBakerId: jest.fn(),
  };

  const mockDelegatorsFeeRepo = {
    getFeeForDelegator: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardCalculatorService,
        {
          provide: TzKTClientService,
          useValue: mockTzKTClient,
        },
        {
          provide: SettingsRepository,
          useValue: mockSettingsRepo,
        },
        {
          provide: DelegatorsFeeRepository,
          useValue: mockDelegatorsFeeRepo,
        },
      ],
    }).compile();

    service = module.get<RewardCalculatorService>(RewardCalculatorService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  /**
   * Test from BUSINESS_LOGIC.md Section 1.2 Example 1
   * rewards = 5,432,100 mutez, fee = 5%
   * paymentValue = (5432100 / 1000000) * 0.95 = 5.160495 tez
   */
  describe('Payment calculation formula', () => {
    it('should match BUSINESS_LOGIC.md Example 1', () => {
      const rewardsMutez = 5_432_100;
      const fee = 5; // 5%

      // Expected: 5.160495 tez
      const expected = new Decimal(5.160495);

      // Calculate
      const rewardsTez = new Decimal(rewardsMutez).div(1_000_000);
      const keepPercentage = new Decimal(100).minus(fee).div(100);
      const result = rewardsTez.times(keepPercentage);

      expect(result.toFixed(6)).toBe(expected.toFixed(6));
    });

    it('should match BUSINESS_LOGIC.md Example 2', () => {
      const rewardsMutez = 1_000_000;
      const fee = 10; // 10%

      // Expected: 0.90 tez
      const expected = new Decimal(0.90);

      // Calculate
      const rewardsTez = new Decimal(rewardsMutez).div(1_000_000);
      const keepPercentage = new Decimal(100).minus(fee).div(100);
      const result = rewardsTez.times(keepPercentage);

      expect(result.toFixed(6)).toBe(expected.toFixed(6));
    });
  });

  /**
   * Test precision handling (6 decimal places)
   */
  describe('Decimal precision', () => {
    it('should round to 6 decimal places', () => {
      const value = new Decimal('1.1234567890');
      const rounded = new Decimal(value.toFixed(6));

      expect(rounded.toString()).toBe('1.123457');
    });

    it('should handle very small amounts', () => {
      const value = new Decimal('0.0000001');
      const rounded = new Decimal(value.toFixed(6));

      expect(rounded.toString()).toBe('0.000000');
    });
  });

  /**
   * Test validation
   */
  describe('validateCalculation', () => {
    it('should validate correct calculation', () => {
      const result = {
        cycle: 500,
        totalRewards: new Decimal(100),
        delegatorRewards: [
          {
            address: 'tz1abc',
            grossReward: new Decimal(60),
            fee: new Decimal(5),
            netReward: new Decimal(57),
            netRewardMutez: 57_000_000,
          },
          {
            address: 'tz1def',
            grossReward: new Decimal(40),
            fee: new Decimal(10),
            netReward: new Decimal(36),
            netRewardMutez: 36_000_000,
          },
        ],
        totalDelegatorPayments: new Decimal(93),
        bakerShare: new Decimal(7),
      };

      const validation = service.validateCalculation(result);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect total exceeding rewards', () => {
      const result = {
        cycle: 500,
        totalRewards: new Decimal(100),
        delegatorRewards: [],
        totalDelegatorPayments: new Decimal(90),
        bakerShare: new Decimal(20), // Total would be 110
      };

      const validation = service.validateCalculation(result);

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('should detect negative rewards', () => {
      const result = {
        cycle: 500,
        totalRewards: new Decimal(100),
        delegatorRewards: [
          {
            address: 'tz1abc',
            grossReward: new Decimal(10),
            fee: new Decimal(5),
            netReward: new Decimal(-1), // Negative!
            netRewardMutez: -1_000_000,
          },
        ],
        totalDelegatorPayments: new Decimal(0),
        bakerShare: new Decimal(100),
      };

      const validation = service.validateCalculation(result);

      expect(validation.valid).toBe(false);
    });
  });

  /**
   * Test fee calculation
   */
  describe('calculateTotalFees', () => {
    it('should calculate total fees correctly', () => {
      const rewards = [
        {
          address: 'tz1abc',
          grossReward: new Decimal(100),
          fee: new Decimal(5),
          netReward: new Decimal(95),
          netRewardMutez: 95_000_000,
        },
        {
          address: 'tz1def',
          grossReward: new Decimal(50),
          fee: new Decimal(10),
          netReward: new Decimal(45),
          netRewardMutez: 45_000_000,
        },
      ];

      const totalFees = service.calculateTotalFees(rewards);

      // Expected: (100-95) + (50-45) = 5 + 5 = 10
      expect(totalFees.toNumber()).toBe(10);
    });
  });
});
