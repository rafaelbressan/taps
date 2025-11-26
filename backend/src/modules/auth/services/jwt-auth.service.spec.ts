import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { JwtAuthService } from './jwt-auth.service';

describe('JwtAuthService', () => {
  let service: JwtAuthService;
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'test-secret-key',
          signOptions: { expiresIn: '24h' },
        }),
      ],
      providers: [JwtAuthService],
    }).compile();

    service = module.get<JwtAuthService>(JwtAuthService);
    jwtService = module.get<JwtService>(JwtService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateToken', () => {
    it('should generate valid JWT token', async () => {
      const payload = {
        sub: 'baker123',
        username: 'testbaker',
      };

      const token = await service.generateToken(payload);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT format
    });

    it('should include payload in token', async () => {
      const payload = {
        sub: 'baker123',
        username: 'testbaker',
      };

      const token = await service.generateToken(payload);
      const decoded = await jwtService.verifyAsync(token);

      expect(decoded.sub).toBe(payload.sub);
      expect(decoded.username).toBe(payload.username);
    });

    it('should set expiration time', async () => {
      const payload = {
        sub: 'baker123',
        username: 'testbaker',
      };

      const token = await service.generateToken(payload);
      const decoded = await jwtService.verifyAsync(token);

      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeGreaterThan(decoded.iat);
    });
  });

  describe('verifyToken', () => {
    it('should verify valid token', async () => {
      const payload = {
        sub: 'baker123',
        username: 'testbaker',
      };

      const token = await service.generateToken(payload);
      const result = await service.verifyToken(token);

      expect(result).toBeDefined();
      expect(result.sub).toBe(payload.sub);
      expect(result.username).toBe(payload.username);
    });

    it('should reject invalid token', async () => {
      const invalidToken = 'invalid.token.here';

      await expect(service.verifyToken(invalidToken)).rejects.toThrow();
    });

    it('should reject expired token', async () => {
      // Create a token that expires immediately
      const payload = { sub: 'baker123', username: 'testbaker' };
      const expiredToken = await jwtService.signAsync(payload, {
        expiresIn: '0s',
      });

      // Wait a bit to ensure expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(service.verifyToken(expiredToken)).rejects.toThrow();
    });
  });

  describe('decodeToken', () => {
    it('should decode token without verification', async () => {
      const payload = {
        sub: 'baker123',
        username: 'testbaker',
      };

      const token = await service.generateToken(payload);
      const decoded = service.decodeToken(token);

      expect(decoded).toBeDefined();
      expect(decoded).not.toBeNull();
      expect(decoded!.sub).toBe(payload.sub);
      expect(decoded!.username).toBe(payload.username);
    });

    it('should decode expired token', async () => {
      const payload = { sub: 'baker123', username: 'testbaker' };
      const expiredToken = await jwtService.signAsync(payload, {
        expiresIn: '0s',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const decoded = service.decodeToken(expiredToken);

      expect(decoded).toBeDefined();
      expect(decoded).not.toBeNull();
      expect(decoded!.sub).toBe(payload.sub);
    });

    it('should return null for invalid token', () => {
      const invalidToken = 'not-a-valid-token';
      const decoded = service.decodeToken(invalidToken);

      expect(decoded).toBeNull();
    });
  });
});
