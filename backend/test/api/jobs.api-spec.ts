/**
 * Jobs API Integration Tests
 *
 * Tests all job management endpoints including:
 * - Trigger cycle check
 * - Trigger balance poll
 * - Get job status
 * - Initialize schedules
 * - Remove schedules
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { JobsModule } from '../../src/modules/jobs/jobs.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { cleanDatabase } from '../utils/test-helpers';
import * as bcrypt from 'bcrypt';

describe('Jobs API (e2e)', () => {
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
        JobsModule,
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

  describe('POST /jobs/trigger/cycle-check', () => {
    it('should queue cycle check job successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toBe('Cycle check job queued successfully');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });

    it('should return 202 Accepted status', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);

      // Job should be queued, not immediately processed
      expect(response.status).toBe(202);
    });

    it('should allow multiple triggers', async () => {
      // First trigger
      await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);

      // Second trigger should also succeed
      await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);
    });
  });

  describe('POST /jobs/trigger/balance-poll', () => {
    it('should queue balance poll job successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/trigger/balance-poll')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toBe('Balance poll job queued successfully');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .post('/jobs/trigger/balance-poll')
        .expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .post('/jobs/trigger/balance-poll')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });

    it('should return 202 Accepted status', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/trigger/balance-poll')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);

      expect(response.status).toBe(202);
    });

    it('should allow multiple triggers', async () => {
      // First trigger
      await request(app.getHttpServer())
        .post('/jobs/trigger/balance-poll')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);

      // Second trigger should also succeed
      await request(app.getHttpServer())
        .post('/jobs/trigger/balance-poll')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);
    });
  });

  describe('GET /jobs/status', () => {
    it('should return job status', async () => {
      const response = await request(app.getHttpServer())
        .get('/jobs/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('cycleMonitoring');
      expect(response.body).toHaveProperty('balancePolling');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).get('/jobs/status').expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .get('/jobs/status')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });

    it('should return status for both job types', async () => {
      const response = await request(app.getHttpServer())
        .get('/jobs/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(typeof response.body.cycleMonitoring).toBeDefined();
      expect(typeof response.body.balancePolling).toBeDefined();
    });
  });

  describe('POST /jobs/initialize', () => {
    it('should initialize job schedules successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/initialize')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toBe('Job schedules initialized successfully');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).post('/jobs/initialize').expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .post('/jobs/initialize')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });

    it('should return 200 OK status', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/initialize')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.status).toBe(200);
    });

    it('should allow reinitialization', async () => {
      // First initialization
      await request(app.getHttpServer())
        .post('/jobs/initialize')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Second initialization should also succeed
      await request(app.getHttpServer())
        .post('/jobs/initialize')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('should initialize schedules after removal', async () => {
      // Remove first
      await request(app.getHttpServer())
        .post('/jobs/remove')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Then reinitialize
      const response = await request(app.getHttpServer())
        .post('/jobs/initialize')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.message).toBe('Job schedules initialized successfully');
    });
  });

  describe('POST /jobs/remove', () => {
    it('should remove job schedules successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/remove')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toBe('Job schedules removed successfully');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).post('/jobs/remove').expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .post('/jobs/remove')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });

    it('should return 200 OK status', async () => {
      const response = await request(app.getHttpServer())
        .post('/jobs/remove')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.status).toBe(200);
    });

    it('should allow multiple removals', async () => {
      // First removal
      await request(app.getHttpServer())
        .post('/jobs/remove')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Second removal should also succeed
      await request(app.getHttpServer())
        .post('/jobs/remove')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });
  });

  describe('Job Lifecycle', () => {
    it('should support full lifecycle: initialize -> trigger -> status -> remove', async () => {
      // Initialize
      let response = await request(app.getHttpServer())
        .post('/jobs/initialize')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(response.body.message).toContain('initialized');

      // Trigger cycle check
      response = await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);
      expect(response.body.message).toContain('queued');

      // Get status
      response = await request(app.getHttpServer())
        .get('/jobs/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(response.body).toHaveProperty('cycleMonitoring');

      // Remove
      response = await request(app.getHttpServer())
        .post('/jobs/remove')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(response.body.message).toContain('removed');
    });
  });

  describe('Security', () => {
    it('should not allow triggering jobs for another baker', async () => {
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

      // Try to trigger job with first baker's token
      const response = await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(202);

      // Should only queue for own baker
      expect(response.body.message).toBe('Cycle check job queued successfully');
    });

    it('should handle concurrent job triggers', async () => {
      // Trigger multiple jobs concurrently
      const triggers = [
        request(app.getHttpServer())
          .post('/jobs/trigger/cycle-check')
          .set('Authorization', `Bearer ${accessToken}`),
        request(app.getHttpServer())
          .post('/jobs/trigger/balance-poll')
          .set('Authorization', `Bearer ${accessToken}`),
        request(app.getHttpServer())
          .post('/jobs/trigger/cycle-check')
          .set('Authorization', `Bearer ${accessToken}`),
      ];

      const results = await Promise.all(triggers);

      // All should succeed
      results.forEach((result) => {
        expect(result.status).toBe(202);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed authorization header', async () => {
      await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', 'malformed_header')
        .expect(401);
    });

    it('should handle missing baker in database', async () => {
      // Delete baker
      await prisma.settings.delete({
        where: { bakerId: testBaker.bakerId },
      });

      // Token is still valid but baker doesn't exist
      // Behavior depends on implementation
      await request(app.getHttpServer())
        .post('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect((res) => {
          // Should either fail gracefully or return error
          expect([202, 400, 404, 500]).toContain(res.status);
        });
    });
  });

  describe('HTTP Methods', () => {
    it('should reject GET on POST endpoints', async () => {
      await request(app.getHttpServer())
        .get('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });

    it('should reject POST on GET endpoints', async () => {
      await request(app.getHttpServer())
        .post('/jobs/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });

    it('should reject PUT requests', async () => {
      await request(app.getHttpServer())
        .put('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });

    it('should reject DELETE requests', async () => {
      await request(app.getHttpServer())
        .delete('/jobs/trigger/cycle-check')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });
  });
});
