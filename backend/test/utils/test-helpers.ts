/**
 * Test Helper Utilities
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';

/**
 * Create a test application instance
 */
export async function createTestApp(
  moduleMetadata: any,
): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule(
    moduleMetadata,
  ).compile();

  const app = moduleFixture.createNestApplication();

  // Apply same configuration as main app
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api');

  await app.init();

  return app;
}

/**
 * Clean test database
 */
export async function cleanDatabase(prisma: PrismaService): Promise<void> {
  // Delete in correct order to avoid foreign key constraints
  await prisma.delegatorPayment.deleteMany({});
  await prisma.delegatorFee.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.bondPoolMember.deleteMany({});
  await prisma.bondPoolSettings.deleteMany({});
  await prisma.settings.deleteMany({});
}

/**
 * Seed test database with baker
 */
export async function seedTestBaker(
  prisma: PrismaService,
  bakerData: any,
): Promise<void> {
  await prisma.settings.create({
    data: bakerData,
  });
}

/**
 * Seed test database with delegators
 */
export async function seedTestDelegators(
  prisma: PrismaService,
  bakerId: string,
  delegators: any[],
): Promise<void> {
  for (const delegator of delegators) {
    await prisma.delegatorPayment.create({
      data: {
        bakerId,
        delegatorAddress: delegator.address,
        cycle: 500,
        balance: delegator.stakingBalance,
        fee: delegator.fee,
        paymentValue: 0,
        result: 'pending',
      },
    });
  }
}

/**
 * Generate mock JWT token for testing
 */
export function generateTestJWT(bakerId: string, username: string): string {
  // For testing, we'll use a simple format
  // In real tests, use actual JWT generation
  return `Bearer test-token-${bakerId}`;
}

/**
 * Compare decimal values with tolerance
 */
export function compareDecimals(
  actual: number | string,
  expected: number | string,
  tolerance: number = 0.000001,
): boolean {
  const actualNum =
    typeof actual === 'string' ? parseFloat(actual) : actual;
  const expectedNum =
    typeof expected === 'string' ? parseFloat(expected) : expected;

  return Math.abs(actualNum - expectedNum) < tolerance;
}

/**
 * Wait for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock Tezos RPC response
 */
export function mockTezosRPC() {
  return {
    getCurrentCycle: jest.fn().mockResolvedValue(500),
    getBalance: jest.fn().mockResolvedValue(1000),
    getBlockHeader: jest.fn().mockResolvedValue({
      level: 2048000,
      timestamp: new Date().toISOString(),
    }),
  };
}

/**
 * Mock TzKT API response
 */
export function mockTzKTAPI() {
  return {
    getBakerRewards: jest.fn().mockResolvedValue({
      cycle: 500,
      stakingBalance: 15000000000,
      rewards: 96500000,
    }),
    getDelegators: jest.fn().mockResolvedValue([
      {
        address: 'tz1Delegator1',
        stakingBalance: 10000000000,
      },
    ]),
  };
}
