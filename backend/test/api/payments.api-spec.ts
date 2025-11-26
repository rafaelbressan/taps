/**
 * Payments API Integration Tests
 *
 * Tests all payment endpoints including:
 * - Get payment history (paginated)
 * - Get cycle payments
 * - Get pending cycle
 * - Distribute rewards
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { PaymentsModule } from '../../src/modules/payments/payments.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { cleanDatabase } from '../utils/test-helpers';
import * as bcrypt from 'bcrypt';

describe('Payments API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;

  const testBaker = {
    bakerId: 'tz1TestBaker123456789',
    userName: 'testbaker',
    password: 'TestPassword123!',
    defaultFee: 5.0,
    mode: 'simulation',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        AuthModule,
        PaymentsModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await cleanDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);

    // Create test baker
    const passHash = await bcrypt.hash(testBaker.password, 12);
    await prisma.settings.create({
      data: {
        bakerId: testBaker.bakerId,
        userName: testBaker.userName,
        passHash,
        defaultFee: testBaker.defaultFee,
        mode: testBaker.mode,
        admCharge: 10.0,
        minPayment: 0.0,
        overDel: false,
        paymentRetries: 3,
        minutesBetweenRetries: 5,
        updateFreq: 10,
        address: testBaker.bakerId,
        alias: 'Test Baker',
        active: true,
      },
    });

    // Login to get access token
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        username: testBaker.userName,
        password: testBaker.password,
      });

    accessToken = loginResponse.body.access_token;
  });

  describe('GET /payments/history', () => {
    beforeEach(async () => {
      // Create test payment records
      for (let i = 500; i < 510; i++) {
        await prisma.payment.create({
          data: {
            bakerId: testBaker.bakerId,
            cycle: i,
            delegatorDistribution: {
              totalPaid: 100.0 + i,
              delegatorsPaid: 10,
            },
            bondDistribution: null,
            result: i % 3 === 0 ? 'failed' : 'paid',
            transactionHash: i % 3 === 0 ? null : `ophash${i}`,
            cycleDate: new Date(2024, 0, i - 499),
            paidDate: new Date(2024, 0, i - 498),
            errorMessage: i % 3 === 0 ? 'Test error' : null,
          },
        });
      }
    });

    it('should return paginated payment history', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('page');
      expect(response.body).toHaveProperty('limit');
      expect(response.body).toHaveProperty('total_pages');

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.total).toBe(10);
      expect(response.body.page).toBe(1);
    });

    it('should return payments sorted by date descending', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const cycles = response.body.data.map((p: any) => p.cycle);

      // Check if sorted descending
      for (let i = 0; i < cycles.length - 1; i++) {
        expect(cycles[i]).toBeGreaterThanOrEqual(cycles[i + 1]);
      }
    });

    it('should paginate results correctly', async () => {
      const response1 = await request(app.getHttpServer())
        .get('/payments/history?page=1&limit=5')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response1.body.data.length).toBe(5);
      expect(response1.body.page).toBe(1);
      expect(response1.body.limit).toBe(5);
      expect(response1.body.total_pages).toBe(2);

      const response2 = await request(app.getHttpServer())
        .get('/payments/history?page=2&limit=5')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response2.body.data.length).toBe(5);
      expect(response2.body.page).toBe(2);

      // Ensure different records
      const cycle1 = response1.body.data[0].cycle;
      const cycle2 = response2.body.data[0].cycle;
      expect(cycle1).not.toBe(cycle2);
    });

    it('should filter by status', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history?status=paid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data.every((p: any) => p.status === 'paid')).toBe(
        true,
      );
    });

    it('should filter by status=failed', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history?status=failed')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data.every((p: any) => p.status === 'failed')).toBe(
        true,
      );
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('should filter by start date', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history?startDate=2024-01-05T00:00:00Z')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data.length).toBeLessThan(10);
    });

    it('should filter by end date', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history?endDate=2024-01-05T00:00:00Z')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data.length).toBeLessThan(10);
    });

    it('should filter by date range', async () => {
      const response = await request(app.getHttpServer())
        .get(
          '/payments/history?startDate=2024-01-03T00:00:00Z&endDate=2024-01-07T00:00:00Z',
        )
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data.length).toBeLessThan(10);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('should validate page is positive integer', async () => {
      await request(app.getHttpServer())
        .get('/payments/history?page=0')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('should validate limit is within range', async () => {
      await request(app.getHttpServer())
        .get('/payments/history?limit=101')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('should validate status enum', async () => {
      await request(app.getHttpServer())
        .get('/payments/history?status=invalid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('should validate date format', async () => {
      await request(app.getHttpServer())
        .get('/payments/history?startDate=invalid-date')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).get('/payments/history').expect(401);
    });

    it('should return empty data for user with no payments', async () => {
      // Clean payments
      await prisma.payment.deleteMany({
        where: { bakerId: testBaker.bakerId },
      });

      const response = await request(app.getHttpServer())
        .get('/payments/history')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    it('should include payment details', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const payment = response.body.data[0];
      expect(payment).toHaveProperty('cycle');
      expect(payment).toHaveProperty('date');
      expect(payment).toHaveProperty('gross_rewards');
      expect(payment).toHaveProperty('net_rewards');
      expect(payment).toHaveProperty('baker_fee');
      expect(payment).toHaveProperty('delegators_count');
      expect(payment).toHaveProperty('status');
    });

    it('should include transaction hash for paid payments', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history?status=paid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const payment = response.body.data[0];
      expect(payment.transaction_hash).toBeTruthy();
      expect(payment.transaction_hash).toMatch(/^ophash/);
    });

    it('should include error message for failed payments', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/history?status=failed')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const payment = response.body.data[0];
      expect(payment.error_message).toBe('Test error');
    });
  });

  describe('GET /payments/cycle/:cycle', () => {
    beforeEach(async () => {
      // Create payment for cycle 500
      await prisma.payment.create({
        data: {
          bakerId: testBaker.bakerId,
          cycle: 500,
          delegatorDistribution: {
            totalPaid: 100.0,
            delegatorsPaid: 2,
          },
          bondDistribution: null,
          result: 'paid',
          transactionHash: 'ophash500',
          cycleDate: new Date(),
          paidDate: new Date(),
        },
      });

      // Create delegator payments
      await prisma.delegatorPayment.create({
        data: {
          bakerId: testBaker.bakerId,
          cycle: 500,
          delegatorAddress: 'tz1Delegator1',
          paymentValue: 50.0,
          fee: 5.0,
          balance: 10000.0,
          result: 'paid',
          transactionId: 'ophash500_1',
          date: new Date(),
        },
      });

      await prisma.delegatorPayment.create({
        data: {
          bakerId: testBaker.bakerId,
          cycle: 500,
          delegatorAddress: 'tz1Delegator2',
          paymentValue: 50.0,
          fee: 5.0,
          balance: 10000.0,
          result: 'paid',
          transactionId: 'ophash500_2',
          date: new Date(),
        },
      });
    });

    it('should return payment details for specific cycle', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/cycle/500')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.cycle).toBe(500);
      expect(response.body.payment).toBeDefined();
      expect(response.body.delegator_payments).toBeDefined();
      expect(Array.isArray(response.body.delegator_payments)).toBe(true);
    });

    it('should include payment summary', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/cycle/500')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.payment).toHaveProperty('cycle', 500);
      expect(response.body.payment).toHaveProperty('status', 'paid');
      expect(response.body.payment).toHaveProperty('delegators_count', 2);
      expect(response.body.payment).toHaveProperty('transaction_hash');
    });

    it('should include delegator payment details', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/cycle/500')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.delegator_payments.length).toBe(2);

      const delegator = response.body.delegator_payments[0];
      expect(delegator).toHaveProperty('address');
      expect(delegator).toHaveProperty('amount', 50.0);
      expect(delegator).toHaveProperty('fee', 5.0);
      expect(delegator).toHaveProperty('balance', 10000.0);
      expect(delegator).toHaveProperty('status', 'paid');
      expect(delegator).toHaveProperty('transaction_hash');
    });

    it('should fail for non-existent cycle', async () => {
      await request(app.getHttpServer())
        .get('/payments/cycle/999')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('should fail with invalid cycle parameter', async () => {
      await request(app.getHttpServer())
        .get('/payments/cycle/invalid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).get('/payments/cycle/500').expect(401);
    });

    it('should validate cycle is a number', async () => {
      await request(app.getHttpServer())
        .get('/payments/cycle/abc')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });
  });

  describe('GET /payments/pending', () => {
    it('should return pending cycle when pending payments exist', async () => {
      // Create pending payment
      await prisma.payment.create({
        data: {
          bakerId: testBaker.bakerId,
          cycle: 505,
          delegatorDistribution: { totalPaid: 0, delegatorsPaid: 0 },
          bondDistribution: null,
          result: 'pending',
          transactionHash: null,
          cycleDate: new Date(),
          paidDate: null,
        },
      });

      const response = await request(app.getHttpServer())
        .get('/payments/pending')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.cycle).toBe(505);
    });

    it('should return lowest pending cycle when multiple exist', async () => {
      await prisma.payment.createMany({
        data: [
          {
            bakerId: testBaker.bakerId,
            cycle: 505,
            delegatorDistribution: { totalPaid: 0, delegatorsPaid: 0 },
            bondDistribution: null,
            result: 'pending',
            transactionHash: null,
            cycleDate: new Date(),
            paidDate: null,
          },
          {
            bakerId: testBaker.bakerId,
            cycle: 503,
            delegatorDistribution: { totalPaid: 0, delegatorsPaid: 0 },
            bondDistribution: null,
            result: 'pending',
            transactionHash: null,
            cycleDate: new Date(),
            paidDate: null,
          },
        ],
      });

      const response = await request(app.getHttpServer())
        .get('/payments/pending')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.cycle).toBe(503);
    });

    it('should return next cycle after last paid when no pending', async () => {
      await prisma.payment.create({
        data: {
          bakerId: testBaker.bakerId,
          cycle: 502,
          delegatorDistribution: { totalPaid: 100, delegatorsPaid: 5 },
          bondDistribution: null,
          result: 'paid',
          transactionHash: 'ophash502',
          cycleDate: new Date(),
          paidDate: new Date(),
        },
      });

      const response = await request(app.getHttpServer())
        .get('/payments/pending')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.cycle).toBe(503);
    });

    it('should return 0 when no payments exist', async () => {
      const response = await request(app.getHttpServer())
        .get('/payments/pending')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.cycle).toBe(0);
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).get('/payments/pending').expect(401);
    });
  });

  describe('POST /payments/distribute/:cycle', () => {
    // Note: This endpoint requires WalletAuthGuard which needs wallet passphrase
    // These tests will likely fail without proper wallet setup
    // Testing the endpoint structure and error handling

    it('should require authentication', async () => {
      await request(app.getHttpServer())
        .post('/payments/distribute/500')
        .expect(401);
    });

    it('should require wallet authentication', async () => {
      // Will fail with WalletAuthGuard
      await request(app.getHttpServer())
        .post('/payments/distribute/500')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    it('should validate cycle is a number', async () => {
      await request(app.getHttpServer())
        .post('/payments/distribute/invalid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });
  });

  describe('Security', () => {
    it('should not allow accessing another baker\'s payment history', async () => {
      // Create another baker
      const anotherBaker = {
        bakerId: 'tz1AnotherBaker',
        userName: 'anotherbaker',
        password: 'AnotherPassword123!',
      };

      const passHash = await bcrypt.hash(anotherBaker.password, 12);
      await prisma.settings.create({
        data: {
          bakerId: anotherBaker.bakerId,
          userName: anotherBaker.userName,
          passHash,
          defaultFee: 10.0,
          mode: 'off',
          admCharge: 10.0,
          minPayment: 0.0,
          overDel: false,
          paymentRetries: 3,
          minutesBetweenRetries: 5,
          updateFreq: 10,
          address: anotherBaker.bakerId,
          alias: 'Another Baker',
          active: true,
        },
      });

      // Create payment for another baker
      await prisma.payment.create({
        data: {
          bakerId: anotherBaker.bakerId,
          cycle: 600,
          delegatorDistribution: { totalPaid: 200, delegatorsPaid: 5 },
          bondDistribution: null,
          result: 'paid',
          transactionHash: 'ophash600',
          cycleDate: new Date(),
          paidDate: new Date(),
        },
      });

      // Try to access with first baker's token
      const response = await request(app.getHttpServer())
        .get('/payments/history')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Should only see own payments (none in this case)
      expect(response.body.data.length).toBe(0);
    });

    it('should handle SQL injection in cycle parameter', async () => {
      await request(app.getHttpServer())
        .get("/payments/cycle/500' OR '1'='1")
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });
  });
});
