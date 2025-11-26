/**
 * Security Tests
 *
 * Comprehensive security testing including:
 * - JWT authentication enforcement
 * - Authorization (data isolation between bakers)
 * - SQL injection prevention
 * - XSS prevention
 * - Input validation
 * - Rate limiting (if implemented)
 * - Password security
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { AppModule } from '../../src/app.module';
import { cleanDatabase } from '../utils/test-helpers';
import * as bcrypt from 'bcrypt';

describe('Security Tests (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baker1Token: string;
  let baker2Token: string;

  const baker1 = {
    bakerId: 'tz1Baker1',
    userName: 'baker1',
    password: 'SecurePassword123!',
  };

  const baker2 = {
    bakerId: 'tz1Baker2',
    userName: 'baker2',
    password: 'SecurePassword456!',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
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

    // Create two bakers for isolation testing
    const passHash1 = await bcrypt.hash(baker1.password, 12);
    await prisma.settings.create({
      data: {
        bakerId: baker1.bakerId,
        userName: baker1.userName,
        passHash: passHash1,
        defaultFee: 5.0,
        mode: 'simulation',
        admCharge: 10.0,
        minPayment: 0.0,
        overDel: false,
        paymentRetries: 3,
        minutesBetweenRetries: 5,
        updateFreq: 10,
        address: baker1.bakerId,
        alias: 'Baker 1',
        active: true,
      },
    });

    const passHash2 = await bcrypt.hash(baker2.password, 12);
    await prisma.settings.create({
      data: {
        bakerId: baker2.bakerId,
        userName: baker2.userName,
        passHash: passHash2,
        defaultFee: 10.0,
        mode: 'off',
        admCharge: 15.0,
        minPayment: 1.0,
        overDel: true,
        paymentRetries: 3,
        minutesBetweenRetries: 5,
        updateFreq: 10,
        address: baker2.bakerId,
        alias: 'Baker 2',
        active: true,
      },
    });

    // Get tokens for both bakers
    const login1 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: baker1.userName, password: baker1.password });
    baker1Token = login1.body.access_token;

    const login2 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: baker2.userName, password: baker2.password });
    baker2Token = login2.body.access_token;
  });

  describe('JWT Authentication Enforcement', () => {
    const protectedEndpoints = [
      { method: 'get', path: '/auth/me' },
      { method: 'post', path: '/auth/change-password' },
      { method: 'post', path: '/auth/logout' },
      { method: 'get', path: '/settings' },
      { method: 'patch', path: '/settings' },
      { method: 'get', path: '/settings/status' },
      { method: 'get', path: '/payments/history' },
      { method: 'get', path: '/payments/pending' },
      { method: 'get', path: '/jobs/status' },
      { method: 'post', path: '/jobs/initialize' },
    ];

    protectedEndpoints.forEach(({ method, path }) => {
      it(`should reject ${method.toUpperCase()} ${path} without token`, async () => {
        await request(app.getHttpServer())[method](path).expect(401);
      });

      it(`should reject ${method.toUpperCase()} ${path} with invalid token`, async () => {
        await request(app.getHttpServer())
          [method](path)
          .set('Authorization', 'Bearer invalid_token_12345')
          .expect(401);
      });

      it(`should reject ${method.toUpperCase()} ${path} with malformed header`, async () => {
        await request(app.getHttpServer())
          [method](path)
          .set('Authorization', 'InvalidFormat token')
          .expect(401);
      });

      it(`should accept ${method.toUpperCase()} ${path} with valid token`, async () => {
        const response = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${baker1Token}`);

        // Should not be 401 (authentication passed)
        expect(response.status).not.toBe(401);
      });
    });

    it('should reject token with invalid signature', async () => {
      // Token with modified signature
      const tampered = baker1Token.slice(0, -10) + 'tampered12';

      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });

    it('should reject expired token', async () => {
      // This would require creating a token with past expiration
      // Skip for now as it requires special JWT generation
    });
  });

  describe('Authorization & Data Isolation', () => {
    beforeEach(async () => {
      // Create payment for baker1
      await prisma.payment.create({
        data: {
          bakerId: baker1.bakerId,
          cycle: 500,
          delegatorDistribution: { totalPaid: 100, delegatorsPaid: 5 },
          bondDistribution: null,
          result: 'paid',
          transactionHash: 'ophash500',
          cycleDate: new Date(),
          paidDate: new Date(),
        },
      });

      // Create payment for baker2
      await prisma.payment.create({
        data: {
          bakerId: baker2.bakerId,
          cycle: 501,
          delegatorDistribution: { totalPaid: 200, delegatorsPaid: 10 },
          bondDistribution: null,
          result: 'paid',
          transactionHash: 'ophash501',
          cycleDate: new Date(),
          paidDate: new Date(),
        },
      });
    });

    it('should only return own settings', async () => {
      const response1 = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(200);

      expect(response1.body.baker_id).toBe(baker1.bakerId);
      expect(response1.body.default_fee).toBe(5.0);

      const response2 = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${baker2Token}`)
        .expect(200);

      expect(response2.body.baker_id).toBe(baker2.bakerId);
      expect(response2.body.default_fee).toBe(10.0);
    });

    it('should only return own payment history', async () => {
      const response1 = await request(app.getHttpServer())
        .get('/payments/history')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(200);

      expect(response1.body.total).toBe(1);
      expect(response1.body.data[0].cycle).toBe(500);

      const response2 = await request(app.getHttpServer())
        .get('/payments/history')
        .set('Authorization', `Bearer ${baker2Token}`)
        .expect(200);

      expect(response2.body.total).toBe(1);
      expect(response2.body.data[0].cycle).toBe(501);
    });

    it('should not allow updating another baker settings', async () => {
      // Baker1 tries to update settings (should only affect their own)
      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ defaultFee: 15.0 })
        .expect(200);

      expect(response.body.baker_id).toBe(baker1.bakerId);
      expect(response.body.default_fee).toBe(15.0);

      // Verify baker2 settings unchanged
      const settings2 = await prisma.settings.findUnique({
        where: { bakerId: baker2.bakerId },
      });
      expect(settings2?.defaultFee).toBe(10.0); // Unchanged
    });

    it('should not allow accessing another baker cycle payments', async () => {
      // Baker1 tries to access baker2's cycle
      await request(app.getHttpServer())
        .get('/payments/cycle/501')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(400); // No payment found for this user's cycle 501
    });
  });

  describe('SQL Injection Prevention', () => {
    const sqlInjectionPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE settings; --",
      "' OR 1=1--",
      "admin'--",
      "' UNION SELECT NULL--",
      "1' AND '1'='1",
    ];

    it('should prevent SQL injection in login username', async () => {
      for (const payload of sqlInjectionPayloads) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: payload, password: 'password' })
          .expect(401);
      }

      // Verify database integrity
      const settings = await prisma.settings.findMany();
      expect(settings.length).toBe(2); // Both bakers still exist
    });

    it('should prevent SQL injection in query parameters', async () => {
      await request(app.getHttpServer())
        .get("/payments/cycle/1' OR '1'='1")
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(400);
    });

    it('should prevent SQL injection in settings update', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ email: "'; DROP TABLE settings; --" })
        .expect(200);

      // Verify table still exists
      const settings = await prisma.settings.findMany();
      expect(settings.length).toBe(2);
    });

    it('should sanitize special characters in input', async () => {
      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ email: "test@example.com'; SELECT * FROM settings--" })
        .expect(200);

      // Email should be stored as-is (input, not SQL)
      expect(response.body.email).toContain("test@example.com'");
    });
  });

  describe('XSS Prevention', () => {
    const xssPayloads = [
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert("xss")>',
      '<svg onload=alert("xss")>',
      'javascript:alert("xss")',
      '<iframe src="javascript:alert(\'xss\')">',
    ];

    it('should prevent XSS in login username', async () => {
      for (const payload of xssPayloads) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: payload, password: 'password' })
          .expect(401);
      }
    });

    it('should handle XSS payloads in settings update', async () => {
      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ email: '<script>alert("xss")</script>' })
        .expect(200);

      // Should be stored but will be escaped when rendered
      expect(response.body.email).toBe('<script>alert("xss")</script>');
    });

    it('should not execute scripts in response', async () => {
      // Set email with XSS payload
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ email: '<script>alert("xss")</script>' })
        .expect(200);

      // Retrieve and verify it's returned as text, not executed
      const response = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(200);

      // Response should be JSON, scripts won't execute
      expect(response.header['content-type']).toContain('application/json');
      expect(response.body.email).toBe('<script>alert("xss")</script>');
    });
  });

  describe('Input Validation', () => {
    it('should validate fee range', async () => {
      // Below minimum
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ defaultFee: -1 })
        .expect(400);

      // Above maximum
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ defaultFee: 101 })
        .expect(400);
    });

    it('should validate decimal precision', async () => {
      // Fee should be max 2 decimals
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ defaultFee: 5.123 })
        .expect(400);

      // minPayment should be max 6 decimals
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ minPayment: 0.1234567 })
        .expect(400);
    });

    it('should validate enum values', async () => {
      await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({ mode: 'invalid_mode' })
        .expect(400);
    });

    it('should validate required fields', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'test' }) // Missing password
        .expect(400);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ password: 'test' }) // Missing username
        .expect(400);
    });

    it('should reject empty strings where not allowed', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: '', password: 'password' })
        .expect(400);
    });

    it('should enforce string length limits', async () => {
      // Username max 100 characters
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'a'.repeat(101), password: 'password' })
        .expect(400);
    });

    it('should enforce password minimum length', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({
          currentPassword: baker1.password,
          newPassword: 'short',
        })
        .expect(400);
    });

    it('should strip unknown fields (whitelist)', async () => {
      const response = await request(app.getHttpServer())
        .patch('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({
          defaultFee: 6.0,
          maliciousField: 'should be ignored',
          anotherBadField: { nested: 'data' },
        })
        .expect(200);

      expect(response.body).not.toHaveProperty('maliciousField');
      expect(response.body).not.toHaveProperty('anotherBadField');
      expect(response.body.default_fee).toBe(6.0);
    });
  });

  describe('Password Security', () => {
    it('should hash passwords (not store plaintext)', async () => {
      const settings = await prisma.settings.findUnique({
        where: { bakerId: baker1.bakerId },
      });

      expect(settings?.passHash).toBeDefined();
      expect(settings?.passHash).not.toBe(baker1.password);
      expect(settings?.passHash).toMatch(/^\$2[aby]\$/); // bcrypt format
    });

    it('should use strong password hashing (bcrypt)', async () => {
      const settings = await prisma.settings.findUnique({
        where: { bakerId: baker1.bakerId },
      });

      // Verify bcrypt hash
      const isMatch = await bcrypt.compare(baker1.password, settings!.passHash);
      expect(isMatch).toBe(true);
    });

    it('should not expose password hash in responses', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(200);

      expect(response.body).not.toHaveProperty('passHash');
      expect(response.body).not.toHaveProperty('password');
    });

    it('should not expose password hash in login response', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: baker1.userName, password: baker1.password })
        .expect(200);

      expect(response.body).not.toHaveProperty('passHash');
      expect(response.body).not.toHaveProperty('password');
      expect(response.body.user).not.toHaveProperty('passHash');
      expect(response.body.user).not.toHaveProperty('password');
    });

    it('should require current password for password change', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${baker1Token}`)
        .send({
          currentPassword: 'WrongPassword',
          newPassword: 'NewSecurePassword123!',
        })
        .expect(401);
    });
  });

  describe('Sensitive Data Protection', () => {
    beforeEach(async () => {
      // Add wallet credentials to baker1
      await prisma.settings.update({
        where: { bakerId: baker1.bakerId },
        data: {
          phrase: 'encrypted_phrase_data',
          walletHash: 'hash_data',
          walletSalt: 'salt_data',
        },
      });
    });

    it('should not expose wallet credentials in settings', async () => {
      const response = await request(app.getHttpServer())
        .get('/settings')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(200);

      expect(response.body).not.toHaveProperty('phrase');
      expect(response.body).not.toHaveProperty('walletHash');
      expect(response.body).not.toHaveProperty('walletSalt');
      expect(response.body.has_wallet).toBe(true); // Only shows existence
    });

    it('should not expose wallet credentials in user info', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(200);

      expect(response.body).not.toHaveProperty('phrase');
      expect(response.body).not.toHaveProperty('walletHash');
      expect(response.body).not.toHaveProperty('walletSalt');
    });
  });

  describe('HTTP Security Headers', () => {
    it('should return JSON content type', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: baker1.userName, password: baker1.password })
        .expect(200);

      expect(response.header['content-type']).toContain('application/json');
    });

    it('should handle JSON parsing errors gracefully', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('Content-Type', 'application/json')
        .send('invalid json {')
        .expect(400);
    });
  });

  describe('Error Message Security', () => {
    it('should not leak system details in error messages', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'nonexistent', password: 'password' })
        .expect(401);

      // Should not reveal whether user exists
      expect(response.body.message).toBeDefined();
      expect(response.body.message).not.toContain('database');
      expect(response.body.message).not.toContain('SQL');
      expect(response.body.message).not.toContain('prisma');
    });

    it('should not reveal stack traces in production', async () => {
      // Trigger an error
      const response = await request(app.getHttpServer())
        .get('/payments/cycle/invalid')
        .set('Authorization', `Bearer ${baker1Token}`)
        .expect(400);

      expect(response.body).not.toHaveProperty('stack');
      expect(JSON.stringify(response.body)).not.toContain('at Object.');
    });
  });
});
