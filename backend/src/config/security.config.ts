/**
 * Security Configuration
 *
 * Centralized security settings for the application
 */

/**
 * Rate Limiting Configuration
 *
 * Protects against brute force attacks on authentication endpoints
 */
export const RATE_LIMIT_CONFIG = {
  // Global rate limit: 10 requests per minute
  ttl: parseInt(process.env.THROTTLE_TTL || '60', 10) * 1000, // Convert to milliseconds
  limit: parseInt(process.env.THROTTLE_LIMIT || '10', 10),

  // Stricter limit for auth endpoints: 5 login attempts per 15 minutes
  auth: {
    ttl: 15 * 60 * 1000, // 15 minutes in milliseconds
    limit: 5,
  },

  // Moderate limit for wallet operations: 10 per 5 minutes
  wallet: {
    ttl: 5 * 60 * 1000, // 5 minutes in milliseconds
    limit: 10,
  },
};

/**
 * CORS Configuration
 *
 * Controls which origins can access the API
 */
export const CORS_CONFIG = {
  origin:
    process.env.NODE_ENV === 'production'
      ? process.env.FRONTEND_URL || 'https://yourdomain.com'
      : ['http://localhost:3000', 'http://localhost:4200'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
  ],
  exposedHeaders: ['Authorization'],
  maxAge: 86400, // 24 hours
};

/**
 * Helmet Security Headers Configuration
 *
 * HTTP security headers to protect against common web vulnerabilities
 */
export const HELMET_CONFIG = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow loading external resources
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  frameguard: { action: 'deny' },
  xssFilter: true,
};

/**
 * JWT Configuration
 */
export const JWT_CONFIG = {
  secret: process.env.JWT_SECRET || 'change-this-in-production',
  expiresIn: process.env.JWT_EXPIRATION || '24h',
};

/**
 * Password Policy
 *
 * Enforced by PasswordService.validatePasswordStrength()
 */
export const PASSWORD_POLICY = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: false, // Optional for backward compatibility
};

/**
 * Encryption Configuration
 */
export const ENCRYPTION_CONFIG = {
  algorithm: 'aes-256-cbc',
  keyLength: 32,
  ivLength: 16,
  secret: process.env.ENCRYPTION_SECRET || 'change-this-in-production',
};
