/**
 * Auth API Integration Tests
 *
 * Tests all authentication endpoints including:
 * - Login
 * - Change password
 * - Verify wallet
 * - Get current user
 * - Logout
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { cleanDatabase } from '../utils/test-helpers';
import * as bcrypt from 'bcrypt';

describe('Auth API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
      ],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Apply global validation pipe like in main.ts
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

    // Create test baker with hashed password
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
        phrase: null,
        walletHash: null,
        walletSalt: null,
      },
    });
  });

  describe('POST /auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        })
        .expect(200);

      expect(response.body).toHaveProperty('access_token');
      expect(response.body).toHaveProperty('token_type', 'Bearer');
      expect(response.body).toHaveProperty('expires_in');
      expect(response.body.user).toMatchObject({
        baker_id: testBaker.bakerId,
        username: testBaker.userName,
        operation_mode: testBaker.mode,
      });

      // Verify token is a valid JWT
      expect(response.body.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it('should fail with invalid username', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'nonexistent',
          password: testBaker.password,
        })
        .expect(401);

      expect(response.body.message).toBeDefined();
    });

    it('should fail with invalid password', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: 'WrongPassword',
        })
        .expect(401);

      expect(response.body.message).toBeDefined();
    });

    it('should validate required fields', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({})
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('should reject empty username', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: '',
          password: testBaker.password,
        })
        .expect(400);
    });

    it('should reject empty password', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: '',
        })
        .expect(400);
    });

    it('should reject username longer than 100 characters', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: 'a'.repeat(101),
          password: testBaker.password,
        })
        .expect(400);
    });

    it('should handle case-sensitive usernames', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName.toUpperCase(),
          password: testBaker.password,
        })
        .expect(401);
    });
  });

  describe('GET /auth/me', () => {
    let accessToken: string;

    beforeEach(async () => {
      // Login to get access token
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        });

      accessToken = loginResponse.body.access_token;
    });

    it('should return current user information with valid token', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        baker_id: testBaker.bakerId,
        username: testBaker.userName,
        operation_mode: testBaker.mode,
        has_wallet: false,
      });
    });

    it('should fail without authentication token', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });

    it('should fail with malformed authorization header', async () => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'invalid_format')
        .expect(401);
    });

    it('should show has_wallet=true when wallet is configured', async () => {
      // Add wallet to baker
      await prisma.settings.update({
        where: { bakerId: testBaker.bakerId },
        data: {
          phrase: 'encrypted_phrase',
          walletHash: 'hash',
          walletSalt: 'salt',
        },
      });

      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.has_wallet).toBe(true);
    });
  });

  describe('POST /auth/change-password', () => {
    let accessToken: string;

    beforeEach(async () => {
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        });

      accessToken = loginResponse.body.access_token;
    });

    it('should change password successfully', async () => {
      const newPassword = 'NewPassword456!';

      const response = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          currentPassword: testBaker.password,
          newPassword,
        })
        .expect(200);

      expect(response.body.message).toBe('Password changed successfully');

      // Verify old password no longer works
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        })
        .expect(401);

      // Verify new password works
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: newPassword,
        })
        .expect(200);

      expect(loginResponse.body).toHaveProperty('access_token');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({
          currentPassword: testBaker.password,
          newPassword: 'NewPassword456!',
        })
        .expect(401);
    });

    it('should fail with incorrect current password', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          currentPassword: 'WrongPassword',
          newPassword: 'NewPassword456!',
        })
        .expect(401);
    });

    it('should reject new password shorter than 8 characters', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          currentPassword: testBaker.password,
          newPassword: 'Short1!',
        })
        .expect(400);
    });

    it('should validate required fields', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(400);
    });

    it('should reject empty current password', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          currentPassword: '',
          newPassword: 'NewPassword456!',
        })
        .expect(400);
    });

    it('should reject empty new password', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          currentPassword: testBaker.password,
          newPassword: '',
        })
        .expect(400);
    });
  });

  describe('POST /auth/verify-wallet', () => {
    let accessToken: string;

    beforeEach(async () => {
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        });

      accessToken = loginResponse.body.access_token;
    });

    it('should verify wallet passphrase', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/verify-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          passphrase: 'test_passphrase',
        })
        .expect(200);

      expect(response.body.valid).toBe(true);
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify-wallet')
        .send({
          passphrase: 'test_passphrase',
        })
        .expect(401);
    });

    it('should validate required fields', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(400);
    });

    it('should reject empty passphrase', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          passphrase: '',
        })
        .expect(400);
    });
  });

  describe('POST /auth/logout', () => {
    let accessToken: string;

    beforeEach(async () => {
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        });

      accessToken = loginResponse.body.access_token;
    });

    it('should logout successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.message).toBe('Logged out successfully');
    });

    it('should fail without authentication', async () => {
      await request(app.getHttpServer()).post('/auth/logout').expect(401);
    });

    it('should fail with invalid token', async () => {
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401);
    });
  });

  describe('Token Expiration', () => {
    it('should include expiration information in login response', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        })
        .expect(200);

      expect(response.body.expires_in).toBeDefined();
      expect(typeof response.body.expires_in).toBe('string');
    });
  });

  describe('Security', () => {
    it('should not expose password hash in login response', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        })
        .expect(200);

      expect(response.body).not.toHaveProperty('password');
      expect(response.body).not.toHaveProperty('passHash');
      expect(response.body.user).not.toHaveProperty('password');
      expect(response.body.user).not.toHaveProperty('passHash');
    });

    it('should not expose wallet credentials in user response', async () => {
      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: testBaker.userName,
          password: testBaker.password,
        });

      const accessToken = loginResponse.body.access_token;

      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body).not.toHaveProperty('phrase');
      expect(response.body).not.toHaveProperty('walletHash');
      expect(response.body).not.toHaveProperty('walletSalt');
    });

    it('should handle SQL injection attempts in username', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: "' OR '1'='1",
          password: testBaker.password,
        })
        .expect(401);
    });

    it('should handle XSS attempts in username', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          username: '<script>alert("xss")</script>',
          password: testBaker.password,
        })
        .expect(401);
    });
  });
});
