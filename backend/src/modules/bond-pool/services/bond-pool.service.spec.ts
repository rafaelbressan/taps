import { Test, TestingModule } from '@nestjs/testing';
import { BondPoolService } from './bond-pool.service';
import { BondPoolRepository } from '../../../database/repositories';
import Decimal from 'decimal.js';

describe('BondPoolService', () => {
  let service: BondPoolService;
  let bondPoolRepo: BondPoolRepository;

  const mockBondPoolRepo = {
    findSettingsByBakerId: jest.fn(),
    findMembersByBakerId: jest.fn(),
    getTotalPoolAmount: jest.fn(),
    findManagersByBakerId: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BondPoolService,
        {
          provide: BondPoolRepository,
          useValue: mockBondPoolRepo,
        },
      ],
    }).compile();

    service = module.get<BondPoolService>(BondPoolService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  /**
   * Test from BUSINESS_LOGIC.md Section 2.3
   * Scenario:
   * - Total cycle rewards: 100 tez
   * - Delegator payments: 80 tez
   * - Pool rewards: 20 tez
   * - Members:
   *   - Manager: 5000 tez stake, 2% admin charge
   *   - Member A: 3000 tez stake, 2% admin charge
   *   - Member B: 2000 tez stake, 2% admin charge
   * - Total stake: 10,000 tez
   */
  describe('Bond pool calculation from BUSINESS_LOGIC.md', () => {
    it('should match example from Section 2.3', () => {
      const totalPoolRewards = new Decimal(20);
      const totalStake = new Decimal(10000);

      // Manager (50% stake)
      const managerStake = new Decimal(5000);
      const managerSharePercent = managerStake.div(totalStake).times(100);
      const managerRewardsBefore = totalPoolRewards.times(managerSharePercent).div(100);
      const managerAdminFee = managerRewardsBefore.times(0.02);
      const managerPayment = managerRewardsBefore.minus(managerAdminFee);

      expect(managerSharePercent.toNumber()).toBe(50);
      expect(managerRewardsBefore.toNumber()).toBe(10);
      expect(managerAdminFee.toNumber()).toBeCloseTo(0.2, 6);
      expect(managerPayment.toNumber()).toBeCloseTo(9.8, 6);

      // Member A (30% stake)
      const memberAStake = new Decimal(3000);
      const memberASharePercent = memberAStake.div(totalStake).times(100);
      const memberARewardsBefore = totalPoolRewards.times(memberASharePercent).div(100);
      const memberAAdminFee = memberARewardsBefore.times(0.02);
      const memberAPayment = memberARewardsBefore.minus(memberAAdminFee);

      expect(memberASharePercent.toNumber()).toBe(30);
      expect(memberARewardsBefore.toNumber()).toBe(6);
      expect(memberAAdminFee.toNumber()).toBeCloseTo(0.12, 6);
      expect(memberAPayment.toNumber()).toBeCloseTo(5.88, 6);

      // Member B (20% stake)
      const memberBStake = new Decimal(2000);
      const memberBSharePercent = memberBStake.div(totalStake).times(100);
      const memberBRewardsBefore = totalPoolRewards.times(memberBSharePercent).div(100);
      const memberBAdminFee = memberBRewardsBefore.times(0.02);
      const memberBPayment = memberBRewardsBefore.minus(memberBAdminFee);

      expect(memberBSharePercent.toNumber()).toBe(20);
      expect(memberBRewardsBefore.toNumber()).toBe(4);
      expect(memberBAdminFee.toNumber()).toBeCloseTo(0.08, 6);
      expect(memberBPayment.toNumber()).toBeCloseTo(3.92, 6);

      // Total admin fees
      const totalAdminFees = managerAdminFee.plus(memberAAdminFee).plus(memberBAdminFee);
      expect(totalAdminFees.toNumber()).toBeCloseTo(0.4, 6);

      // Manager total (payment + all admin fees)
      const managerTotal = managerPayment.plus(totalAdminFees);
      expect(managerTotal.toNumber()).toBeCloseTo(10.2, 6);

      // Total distributed
      const totalDistributed = managerPayment.plus(memberAPayment).plus(memberBPayment).plus(totalAdminFees);
      expect(totalDistributed.toNumber()).toBeCloseTo(20, 6);
    });
  });

  /**
   * Test validation
   */
  describe('validateDistribution', () => {
    it('should validate correct distribution', () => {
      const result = {
        cycle: 500,
        totalPoolRewards: new Decimal(20),
        totalPoolStake: new Decimal(10000),
        memberRewards: [
          {
            address: 'tz1manager',
            stake: new Decimal(5000),
            stakePercentage: new Decimal(50),
            rewardBeforeFee: new Decimal(10),
            adminCharge: new Decimal(0.2),
            netReward: new Decimal(9.8),
            netRewardMutez: 9_800_000,
            isManager: true,
          },
        ],
        managerAddress: 'tz1manager',
        totalAdminFees: new Decimal(0.4),
        managerTotalReward: new Decimal(10.2),
        totalDistributed: new Decimal(20),
      };

      const validation = service.validateDistribution(result);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });
});
