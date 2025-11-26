/**
 * Test Delegators Fixture
 *
 * Sample delegator data for testing
 */

export const testDelegators = [
  {
    address: 'tz1Delegator1111111111111111111',
    stakingBalance: 10000000000, // 10,000 XTZ in mutez
    fee: 5.0,
  },
  {
    address: 'tz1Delegator2222222222222222222',
    stakingBalance: 5000000000, // 5,000 XTZ in mutez
    fee: 5.0,
  },
  {
    address: 'tz1Delegator3333333333333333333',
    stakingBalance: 2000000000, // 2,000 XTZ in mutez
    fee: 7.5,
  },
];

export const testDelegatorPayments = [
  {
    id: 1,
    bakerId: 'tz1TestBaker123456789',
    delegatorAddress: 'tz1Delegator1111111111111111111',
    cycle: 500,
    balance: 10000000000,
    fee: 5.0,
    paymentValue: 47.500000,
    transactionId: null,
    result: 'pending',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  },
  {
    id: 2,
    bakerId: 'tz1TestBaker123456789',
    delegatorAddress: 'tz1Delegator2222222222222222222',
    cycle: 500,
    balance: 5000000000,
    fee: 5.0,
    paymentValue: 23.750000,
    transactionId: null,
    result: 'pending',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  },
];

/**
 * Sample TzKT API response for delegators
 */
export const mockTzKTDelegatorsResponse = [
  {
    address: 'tz1Delegator1111111111111111111',
    stakingBalance: 10000000000,
    balance: 10000000000,
  },
  {
    address: 'tz1Delegator2222222222222222222',
    stakingBalance: 5000000000,
    balance: 5000000000,
  },
];

/**
 * Sample TzKT API response for cycle rewards
 */
export const mockTzKTCycleRewardsResponse = {
  cycle: 500,
  stakingBalance: 15000000000,
  delegatedBalance: 15000000000,
  numDelegators: 2,
  expectedBlocks: 32,
  expectedEndorsements: 256,
  futureBlocks: 32,
  futureBlockRewards: 16000000,
  ownBlocks: 32,
  ownBlockRewards: 16000000,
  extraBlocks: 0,
  extraBlockRewards: 0,
  missedOwnBlocks: 0,
  missedOwnBlockRewards: 0,
  missedExtraBlocks: 0,
  missedExtraBlockRewards: 0,
  uncoveredOwnBlocks: 0,
  uncoveredOwnBlockRewards: 0,
  uncoveredExtraBlocks: 0,
  uncoveredExtraBlockRewards: 0,
  blockRewards: 16000000,
  endorsementRewards: 80000000,
  ownBlockFees: 500000,
  extraBlockFees: 0,
  missedOwnBlockFees: 0,
  missedExtraBlockFees: 0,
  uncoveredOwnBlockFees: 0,
  uncoveredExtraBlockFees: 0,
  doubleBakingRewards: 0,
  doubleBakingLostDeposits: 0,
  doubleBakingLostRewards: 0,
  doubleBakingLostFees: 0,
  doubleEndorsingRewards: 0,
  doubleEndorsingLostDeposits: 0,
  doubleEndorsingLostRewards: 0,
  doubleEndorsingLostFees: 0,
  revelationRewards: 0,
  revelationLostRewards: 0,
  revelationLostFees: 0,
};
