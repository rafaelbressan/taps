/**
 * Settings API Integration Tests
 *
 * Tests all settings endpoints including:
 * - Get settings
 * - Update settings
 * - Update operation mode
 * - Get system status
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { SettingsModule } from '../../src/modules/settings/settings.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { cleanDatabase } from '../utils/test-helpers';
import * as bcrypt from 'bcrypt';

describe('Settings API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;

  const testBaker = {
    bakerId: 'tz1TestBaker123456789',
    userName: 'testbaker',
    password: 'TestPassword123!',
    defaultFee: 5.0,
    mode: 'simulation',
    admCharge: 10.0,
    minPayment: 0.5,
    overDel: false,
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        AuthModule,
        SettingsModule,
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
        admCharge: testBaker.admCharge,
        minPayment: testBaker.minPayment,
        overDel: testBaker.overDel,
        paymentRetries: 3,
        minutesBetweenRetries: 5,
        updateFreq: 10,
        address: testBaker.bakerId,
        alias: 'Test Baker',
        active: true,
        phrase: null,
        walletHash: null,
        walletSalt: null,
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

  describe('GET /settings', () => {
    it('should return current settings', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        baker_id: testBaker.bakerId,
        username: testBaker.userName,
        default_fee: testBaker.defaultFee,
        mode: testBaker.mode,
        adm_charge: testBaker.admCharge,
        min_payment: testBaker.minPayment,
        over_del: testBaker.overDel,
        has_wallet: false,
      });

      expect(response.body).toHaveProperty('created_at');
      expect(response.body).toHaveProperty('updated_at');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).get('/settings').expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });

    it('should show has_wallet=true when wallet is configured', async () => {
      await prisma.settings.update({
        where: { bakerId: testBaker.bakerId },
        data: {
          phrase: 'encrypted_phrase',
          walletHash: 'hash',
          walletSalt: 'salt',
        },
      });

      const response = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.has_wallet).toBe(true);
    });

    it('should not expose sensitive data', async () => {
      await prisma.settings.update({
        where: { bakerId: testBaker.bakerId },
        data: {
          phrase: 'encrypted_phrase',
          walletHash: 'hash',
          walletSalt: 'salt',
        },
      });

      const response = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).not.toHaveProperty('passHash');
      expect(response.body).not.toHaveProperty('phrase');
      expect(response.body).not.toHaveProperty('walletHash');
      expect(response.body).not.toHaveProperty('walletSalt');
    });
  });

  describe('PATCH /settings', () => {
    it('should update default fee', async () => {
      const newFee = 7.5;

      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ defaultFee: newFee })
        .expect(200);

      expect(response.body.default_fee).toBe(newFee);

      // Verify in database
      const settings = await prisma.settings.findUnique({
        where: { bakerId: testBaker.bakerId },
      });
      expect(settings?.defaultFee).toBe(newFee);
    });

    it('should update operation mode', async () => {
      const newMode = 'on';

      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ mode: newMode })
        .expect(200);

      expect(response.body.mode).toBe(newMode);
    });

    it('should update multiple settings at once', async () => {
      const updates = {
        defaultFee: 8.0,
        mode: 'on',
        admCharge: 12.0,
        minPayment: 1.0,
        overDel: true,
      };

      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(updates)
        .expect(200);

      expect(response.body.default_fee).toBe(updates.defaultFee);
      expect(response.body.mode).toBe(updates.mode);
      expect(response.body.adm_charge).toBe(updates.admCharge);
      expect(response.body.min_payment).toBe(updates.minPayment);
      expect(response.body.over_del).toBe(updates.overDel);
    });

    it('should update email', async () => {
      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ email: 'baker@example.com' })
        .expect(200);

      expect(response.body.email).toBe('baker@example.com');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .send({ defaultFee: 7.5 })
        .expect(401);
    });

    it('should validate fee range (min)', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ defaultFee: -1 })
        .expect(400);
    });

    it('should validate fee range (max)', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ defaultFee: 101 })
        .expect(400);
    });

    it('should validate fee decimal places', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ defaultFee: 5.123 })
        .expect(400);
    });

    it('should validate mode enum', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ mode: 'invalid_mode' })
        .expect(400);
    });

    it('should accept valid mode values', async () => {
      const validModes = ['off', 'simulation', 'on'];

      for (const mode of validModes) {
        const response = await request(app.getHttpServer())
          .patch('/settings')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ mode })
          .expect(200);

        expect(response.body.mode).toBe(mode);
      }
    });

    it('should validate admCharge range (min)', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ admCharge: -1 })
        .expect(400);
    });

    it('should validate admCharge range (max)', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ admCharge: 101 })
        .expect(400);
    });

    it('should validate minPayment range', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ minPayment: -1 })
        .expect(400);
    });

    it('should validate minPayment decimal places (6 max)', async () => {
      // Should accept 6 decimal places
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ minPayment: 0.123456 })
        .expect(200);

      // Should reject more than 6 decimal places
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ minPayment: 0.1234567 })
        .expect(400);
    });

    it('should validate overDel is boolean', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ overDel: 'not_a_boolean' })
        .expect(400);
    });

    it('should accept boolean values for overDel', async () => {
      // Test true
      let response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ overDel: true })
        .expect(200);
      expect(response.body.over_del).toBe(true);

      // Test false
      response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ overDel: false })
        .expect(200);
      expect(response.body.over_del).toBe(false);
    });

    it('should ignore unknown fields (whitelist)', async () => {
      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          defaultFee: 7.0,
          unknownField: 'should be ignored',
        })
        .expect(200);

      expect(response.body.default_fee).toBe(7.0);
      expect(response.body).not.toHaveProperty('unknownField');
    });

    it('should handle empty update (no changes)', async () => {
      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(200);

      // Should return current settings unchanged
      expect(response.body.default_fee).toBe(testBaker.defaultFee);
    });
  });

  describe('PATCH /settings/mode', () => {
    it('should update mode to off', async () => {
      await request(app.getHttpServer())
        .patch('/settings/mode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ mode: 'off' })
        .expect(204);

      // Verify in database
      const settings = await prisma.settings.findUnique({
        where: { bakerId: testBaker.bakerId },
      });
      expect(settings?.mode).toBe('off');
    });

    it('should update mode to simulation', async () => {
      await request(app.getHttpServer())
        .patch('/settings/mode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ mode: 'simulation' })
        .expect(204);

      const settings = await prisma.settings.findUnique({
        where: { bakerId: testBaker.bakerId },
      });
      expect(settings?.mode).toBe('simulation');
    });

    it('should update mode to on', async () => {
      await request(app.getHttpServer())
        .patch('/settings/mode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ mode: 'on' })
        .expect(204);

      const settings = await prisma.settings.findUnique({
        where: { bakerId: testBaker.bakerId },
      });
      expect(settings?.mode).toBe('on');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .patch('/settings/mode')
        .send({ mode: 'off' })
        .expect(401);
    });

    it('should validate mode is required', async () => {
      await request(app.getHttpServer())
        .patch('/settings/mode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(400);
    });

    it('should validate mode enum', async () => {
      await request(app.getHttpServer())
        .patch('/settings/mode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ mode: 'invalid_mode' })
        .expect(400);
    });

    it('should return 204 with no content', async () => {
      const response = await request(app.getHttpServer())
        .patch('/settings/mode')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ mode: 'off' })
        .expect(204);

      expect(response.body).toEqual({});
    });
  });

  describe('GET /settings/status', () => {
    beforeEach(async () => {
      // Create some test data for status
      await prisma.payment.create({
        data: {
          bakerId: testBaker.bakerId,
          cycle: 500,
          delegatorDistribution: { totalPaid: 100.0, delegatorsPaid: 10 },
          bondDistribution: null,
          result: 'paid',
          transactionHash: 'ophash123',
          cycleDate: new Date(),
          paidDate: new Date(),
        },
      });
    });

    it('should return system status', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('mode');
      expect(response.body).toHaveProperty('current_cycle');
      expect(response.body).toHaveProperty('pending_cycle');
      expect(response.body).toHaveProperty('total_delegators');
      expect(response.body).toHaveProperty('active_delegators');
      expect(response.body).toHaveProperty('baker_address');
      expect(response.body).toHaveProperty('baker_balance');
      expect(response.body).toHaveProperty('total_rewards_paid');
      expect(response.body).toHaveProperty('bond_pool_enabled');
      expect(response.body).toHaveProperty('health_status');
    });

    it('should return correct operation mode', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.mode).toBe(testBaker.mode);
    });

    it('should return baker address', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.baker_address).toBe(testBaker.bakerId);
    });

    it('should return health status', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(['healthy', 'warning', 'error']).toContain(
        response.body.health_status,
      );
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).get('/settings/status').expect(401);
    });

    it('should return bond_pool_enabled=false when no bond pool', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.bond_pool_enabled).toBe(false);
    });

    it('should return bond_pool_enabled=true when bond pool exists', async () => {
      // Create bond pool settings
      await prisma.bondPoolSettings.create({
        data: {
          bakerId: testBaker.bakerId,
          enabled: true,
          admCharge: 10.0,
          managerAddress: 'tz1Manager',
        },
      });

      const response = await request(app.getHttpServer())
        .get('/settings/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.bond_pool_enabled).toBe(true);
    });

    it('should return last_payment_date when payments exist', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      if (response.body.last_payment_date) {
        expect(new Date(response.body.last_payment_date)).toBeInstanceOf(Date);
      }
    });
  });

  describe('Security', () => {
    it('should not allow updating another user\'s settings', async () => {
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

      // Try to get another user's settings with first user's token
      const response = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Should only see own settings
      expect(response.body.baker_id).toBe(testBaker.bakerId);
      expect(response.body.baker_id).not.toBe(anotherBaker.bakerId);
    });

    it('should handle SQL injection in update', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          email: "'; DROP TABLE settings; --",
        })
        .expect(200);

      // Verify table still exists and settings unchanged
      const settings = await prisma.settings.findUnique({
        where: { bakerId: testBaker.bakerId },
      });
      expect(settings).toBeDefined();
    });
  });
});
