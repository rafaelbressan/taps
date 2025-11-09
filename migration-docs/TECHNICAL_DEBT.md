# Technical Debt & Code Quality Analysis

## Overview

This document identifies technical debt, code smells, security concerns, and improvement opportunities in the TAPS ColdFusion codebase. These issues should be addressed during migration to TypeScript.

---

## Code Quality Issues

### 1. Lack of Separation of Concerns

**Severity**: HIGH

**Issue**: CFM files mix presentation, business logic, and data access

**Example**: `setup.cfm`
```cfml
<!-- Lines 1-68: Business logic (parameter extraction) -->
<!-- Lines 69-89: Validation logic -->
<!-- Lines 90-109: Database operations -->
<!-- Lines 110-220: HTML presentation -->
```

**Impact**:
- Hard to test
- Difficult to maintain
- Code duplication

**Migration Fix**:
- Separate into Controller, Service, and View layers
- Use MVC/MVVM pattern with React + NestJS
- Create reusable components

---

### 2. No Input Validation Framework

**Severity**: MEDIUM-HIGH

**Issue**: Manual validation throughout codebase

**Example**: `setup.cfm`
```cfml
<cfif #baker# EQ "" or #fee# EQ "" or #freq# EQ "" ...>
   <cfset validation = "emptyFields">
</cfif>
<cfif #isNumeric(fee)# EQ false or #isNumeric(freq)# EQ false ...>
   <cfset validation = "nonNumericFields">
</cfif>
```

**Problems**:
- Inconsistent validation across endpoints
- No centralized validation rules
- Easy to miss edge cases
- No type safety

**Migration Fix**:
```typescript
// Use class-validator with DTOs
class SetupDto {
  @IsString()
  @Matches(/^tz[123][a-zA-Z0-9]{33}$/)
  bakerId: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  fee: number;

  @IsNumber()
  @Min(1)
  freq: number;
}
```

---

### 3. No Error Handling Standards

**Severity**: MEDIUM

**Issue**: Inconsistent error handling with empty catch blocks

**Example**: `components/taps.cfc`
```cfml
<cfcatch>
   <!--- Silent failure --->
</cfcatch>
```

**Example**: `components/database.cfc`
```cfml
<cftry>
   <cfquery>...</cfquery>
<cfcatch>
   <cfset result = false>  <!--- No error logging --->
</cfcatch>
</cftry>
```

**Problems**:
- Errors swallowed silently
- No logging of failures
- Difficult to debug production issues
- No way to track error rates

**Migration Fix**:
```typescript
// Centralized error handling with NestJS
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const status = exception.getStatus();

    logger.error('HTTP Exception', {
      statusCode: status,
      path: request.url,
      message: exception.message,
    });

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: exception.message,
    });
  }
}
```

---

### 4. Hardcoded Configuration Values

**Severity**: MEDIUM

**Issue**: Configuration mixed with code

**Example**: `application.cfc`
```cfml
<cfset application.encSeed = "?73205!">
<cfset application.proxyServer="">
<cfset application.proxyPort="80">
<cfset application.provider = "https://mainnet-tezos.giganode.io">
<cfset application.gasLimit = 15400>
```

**Problems**:
- Can't change without code modification
- Different values for dev/staging/prod requires code changes
- Secrets in source code

**Migration Fix**:
```typescript
// .env file
ENCRYPTION_SECRET=your-secret-key
PROXY_SERVER=
PROXY_PORT=80
TEZOS_RPC_URL=https://mainnet-tezos.giganode.io
GAS_LIMIT=15400

// config.service.ts
@Injectable()
export class ConfigService {
  get encryptionSecret(): string {
    return process.env.ENCRYPTION_SECRET;
  }
  // ... other config
}
```

---

### 5. Weak Password Hashing

**Severity**: HIGH (Security)

**Issue**: SHA-512 used for password hashing

**Code**: `components/database.cfc`
```cfml
<cfset salt = Hash(GenerateSecretKey("AES"), "SHA-512") />
<cfset hashedPassword = Hash(#arguments.passdw# & #salt#, "SHA-512") />
```

**Problems**:
- SHA-512 is fast (makes brute force easier)
- No configurable work factor
- Not designed for password hashing

**Migration Fix**:
```typescript
// Use bcrypt with configurable rounds
import * as bcrypt from 'bcrypt';

const saltRounds = 12; // Configurable work factor
const hashedPassword = await bcrypt.hash(password, saltRounds);

// Verify
const isValid = await bcrypt.compare(password, hashedPassword);
```

**Why bcrypt is better**:
- Designed specifically for passwords
- Configurable work factor (can increase over time)
- Salts built-in
- Slow by design (resistant to brute force)

---

### 6. No Unit Testing

**Severity**: HIGH

**Issue**: Zero test coverage

**Problems**:
- No way to verify business logic
- Refactoring is risky
- Regressions likely
- Hard to onboard new developers

**Migration Fix**:
```typescript
// Comprehensive test suite
describe('PaymentsService', () => {
  describe('calculatePayment', () => {
    it('should calculate payment correctly', () => {
      const result = service.calculatePayment(5_432_100, 5);
      expect(result).toBeCloseTo(5.160495);
    });

    it('should handle zero fee', () => {
      const result = service.calculatePayment(1_000_000, 0);
      expect(result).toBe(1.0);
    });

    it('should handle 100% fee', () => {
      const result = service.calculatePayment(1_000_000, 100);
      expect(result).toBe(0);
    });
  });
});
```

---

### 7. Magic Numbers & Strings

**Severity**: LOW-MEDIUM

**Issue**: Hardcoded values throughout code

**Examples**:
```cfml
<cfset application.militez = 1000000>
<cfset twentyFourHours = 86400>
<cfset tenMinutes = 600>
<cfset twoMinutes = 120000>

<cfif #len(transactionHash)# GT 45 AND #len(transactionHash)# LT 60>

<cfif #cycle# LT (#currentCycle# - 5)>
   <cfset status = "rewards_delivered">
```

**Problems**:
- Unclear meaning
- Hard to change
- Duplication
- No single source of truth

**Migration Fix**:
```typescript
// constants.ts
export const MUTEZ_PER_TEZ = 1_000_000;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_MINUTE = 60;

export const TX_HASH_MIN_LENGTH = 46;
export const TX_HASH_MAX_LENGTH = 60;

export const CYCLES_UNTIL_DELIVERED = 5;

export enum PaymentStatus {
  REWARDS_PENDING = 'rewards_pending',
  REWARDS_DELIVERED = 'rewards_delivered',
  PAID = 'paid',
  SIMULATED = 'simulated',
  ERRORS = 'errors',
}
```

---

### 8. SQL Injection Risk (Low but Present)

**Severity**: LOW (Mitigated by cfqueryparam)

**Issue**: While `cfqueryparam` is used consistently (good!), some queries use string concatenation

**Example**: `components/database.cfc`
```cfml
<cfquery name="get_local_bondpoolers" datasource="ds_taps">
   SELECT BAKER_ID, ADDRESS, AMOUNT, NAME, ADM_CHARGE, IS_MANAGER
   FROM bondPool
   WHERE BAKER_ID = '#application.bakerId#'  <!--- Not parameterized --->
```

**Note**: `application.bakerId` comes from database, so risk is low, but not best practice.

**Migration Fix**:
```typescript
// Prisma prevents SQL injection by default
const bondPoolers = await prisma.bondPoolMember.findMany({
  where: {
    bakerId: bakerId, // Automatically parameterized
  },
});
```

---

### 9. No Logging Framework

**Severity**: MEDIUM

**Issue**: Logs written to plain text files with no structure

**Current Approach**:
```cfml
<cffile file="../logs/payments_#cycle#.log" action="append" output="#logOutput#">
```

**Problems**:
- No log levels (info, warn, error)
- No structured logging (JSON)
- Hard to parse and analyze
- No log rotation
- No centralized logging

**Migration Fix**:
```typescript
// Winston logger with structured logging
import { Logger } from 'winston';

logger.info('Payment processed', {
  cycle: 500,
  delegatorAddress: 'tz1...',
  amount: 5.123456,
  transactionHash: 'op...',
  timestamp: new Date().toISOString(),
});

logger.error('Payment failed', {
  cycle: 500,
  error: error.message,
  stack: error.stack,
});
```

**Advantages**:
- Structured logs (JSON)
- Log levels
- Easy integration with log aggregators (Elasticsearch, Datadog, etc.)
- Automatic log rotation

---

### 10. No API Versioning

**Severity**: LOW

**Issue**: No versioning strategy for future changes

**Migration Fix**:
```typescript
// NestJS API versioning
@Controller({
  path: 'payments',
  version: '1',
})
export class PaymentsController {
  // v1 endpoints
}

// Later, create v2 without breaking v1
@Controller({
  path: 'payments',
  version: '2',
})
export class PaymentsV2Controller {
  // v2 endpoints with breaking changes
}
```

---

## Architecture Issues

### 11. Monolithic Structure

**Severity**: MEDIUM

**Issue**: Single application handles everything

**Problems**:
- Can't scale individual components
- Single point of failure
- Memory-intensive (all features loaded)

**Migration Fix**: Microservices (optional) or modular monolith
```
Services:
- API Gateway
- Authentication Service
- Payment Processing Service (can scale independently)
- Wallet Service
- Reporting Service
```

---

### 12. No Caching Strategy

**Severity**: MEDIUM

**Issue**: Repeated API calls and database queries

**Example**:
- Every page load fetches settings from database
- Delegator list fetched every time
- Tezos API called without caching

**Migration Fix**:
```typescript
// Redis caching
@Injectable()
export class CacheService {
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl: number = 300,
  ): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }

    const value = await factory();
    await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    return value;
  }
}

// Usage
const delegators = await this.cache.getOrSet(
  `delegators:${bakerId}:${cycle}`,
  () => this.tzkt.getDelegators(bakerId, cycle),
  600, // 10 minutes
);
```

---

### 13. Session-Based Authentication (Limits Scalability)

**Severity**: MEDIUM

**Issue**: Server-side sessions prevent horizontal scaling

**Current**: `cflogin` stores session on server

**Problems**:
- Requires sticky sessions with load balancer
- Session state tied to server
- Memory overhead

**Migration Fix**: Stateless JWT authentication
```typescript
// Generate JWT (stateless)
const token = this.jwtService.sign({
  sub: user.id,
  username: user.username,
});

// No server-side session storage needed
// Can scale horizontally without session replication
```

---

### 14. File-Based Wallet Storage

**Severity**: MEDIUM

**Issue**: Wallet stored as file on disk

**Location**: `wallet/wallet.taps`

**Problems**:
- Not suitable for multi-instance deployment
- No backup/recovery strategy
- File permissions issues in containers

**Migration Fix**:
```typescript
// Option 1: Database storage (encrypted)
await prisma.wallet.create({
  data: {
    bakerId,
    encryptedMnemonic: encrypt(mnemonic, masterKey),
    publicKeyHash: address,
  },
});

// Option 2: Secret management service
// AWS Secrets Manager, Azure Key Vault, HashiCorp Vault
const mnemonic = await secretManager.getSecret('wallet-mnemonic');
```

---

### 15. No Request Timeout Handling

**Severity**: MEDIUM

**Issue**: Some operations have 24-hour timeout

**Code**: `components/taps.cfc`
```cfml
<cfsetting requestTimeout = #twentyFourHours#>
```

**Problems**:
- Blocks server resources
- Can cause cascading failures
- No user feedback during long operations

**Migration Fix**:
```typescript
// Background job with status updates
@Injectable()
export class PaymentsService {
  async distributeRewards(cycle: number) {
    // Create job
    const job = await this.queue.add('distribute-rewards', { cycle });

    // Return job ID immediately
    return { jobId: job.id };
  }

  // Separate endpoint to check status
  async getJobStatus(jobId: string) {
    const job = await this.queue.getJob(jobId);
    return {
      status: await job.getState(),
      progress: job.progress(),
    };
  }
}
```

**Better UX**: Return immediately, use WebSocket or polling for status updates

---

## Performance Issues

### 16. N+1 Query Problem

**Severity**: MEDIUM

**Issue**: Loop with database queries inside

**Example**: `components/taps.cfc`
```cfml
<cfloop query="#arguments.delegators#">
   <cfquery name="local_get_fee" datasource="ds_taps">
      SELECT FEE FROM delegatorsFee
      WHERE BAKER_ID = ? AND ADDRESS = ?
   </cfquery>
</cfloop>
```

**Problem**: If 100 delegators, makes 100 separate queries

**Migration Fix**:
```typescript
// Single query with JOIN
const delegatorsWithFees = await prisma.delegator.findMany({
  where: { bakerId, cycle },
  include: {
    customFee: true, // Prisma handles JOIN
  },
});

// Or use Prisma's dataloader pattern (batching)
```

---

### 17. No Database Indexing Strategy

**Severity**: MEDIUM

**Issue**: No indexes defined (relying on primary keys only)

**Problem**: Slow queries as data grows

**Example Slow Queries**:
```sql
SELECT * FROM delegatorsPayments
WHERE cycle = 500  -- No index on cycle

SELECT * FROM delegatorsFee
WHERE address = 'tz1...'  -- No index on address
```

**Migration Fix**:
```prisma
model DelegatorPayment {
  // ...
  @@index([cycle])
  @@index([address])
  @@index([result])
  @@index([bakerId, cycle])  // Composite index
}
```

---

### 18. Inefficient Bond Pool Calculation

**Severity**: LOW

**Issue**: Fetches total rewards from API every time

**Code**: `components/taps.cfc`
```cfml
<cfinvoke component="components.tezosGateway"
   method="getBakersRewardsInCycle"
   bakerId="#application.bakerId#"
   cycle="#arguments.localPendingRewardsCycle#"
   returnVariable="totalCycleRewards">
```

**Problem**: Already have this data from earlier in the flow

**Migration Fix**: Pass `totalCycleRewards` as parameter instead of re-fetching

---

## Security Issues

### 19. Weak Encryption for Wallet Passphrase

**Severity**: HIGH

**Issue**: Using basic ColdFusion `encrypt()` function

**Code**: `components/database.cfc`
```cfml
<cfset encPassphrase = encrypt('#arguments.passphrase#', '#arguments.passdw#')>
```

**Problems**:
- Unknown encryption algorithm (CFML default)
- Key derivation not specified
- No IV (Initialization Vector)

**Migration Fix**:
```typescript
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

async function encrypt(text: string, password: string): Promise<string> {
  const iv = randomBytes(16);
  const key = (await scryptAsync(password, 'salt', 32)) as Buffer;
  const cipher = createCipheriv('aes-256-cbc', key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return iv.toString('hex') + ':' + encrypted;
}

async function decrypt(encryptedText: string, password: string): Promise<string> {
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = (await scryptAsync(password, 'salt', 32)) as Buffer;
  const decipher = createDecipheriv('aes-256-cbc', key, iv);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

---

### 20. No Rate Limiting

**Severity**: MEDIUM

**Issue**: No protection against brute force or DoS

**Migration Fix**:
```typescript
// NestJS throttler
@Module({
  imports: [
    ThrottlerModule.forRoot({
      ttl: 60,
      limit: 10, // 10 requests per minute
    }),
  ],
})
export class AppModule {}

// Apply to login endpoint
@UseGuards(ThrottlerGuard)
@Post('login')
async login(@Body() loginDto: LoginDto) {
  // ...
}
```

---

### 21. No CSRF Protection

**Severity**: LOW (Mitigated by localhost-only access)

**Issue**: No CSRF tokens on forms

**Migration Fix**:
```typescript
// NestJS CSRF protection
app.use(csurf());

// Or use SameSite cookies with JWT
@Injectable()
export class AuthService {
  login(response: Response, user: User) {
    const token = this.jwtService.sign({ ... });

    response.cookie('jwt', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict', // CSRF protection
    });
  }
}
```

---

### 22. Secrets in Source Code

**Severity**: HIGH

**Issue**: Encryption seed hardcoded

**Code**: `application.cfc`
```cfml
<cfset application.encSeed = "?73205!">
```

**Problems**:
- Visible in version control
- Can't rotate without code change
- Compromises security if repo exposed

**Migration Fix**:
```bash
# .env (not committed to git)
ENCRYPTION_SECRET=randomly-generated-strong-secret

# .gitignore
.env
.env.local
```

---

## Maintainability Issues

### 23. Large Functions

**Severity**: MEDIUM

**Issue**: Functions with 600+ lines (e.g., `distributeRewards()`)

**Problems**:
- Hard to understand
- Hard to test
- Hard to modify
- Multiple responsibilities

**Migration Fix**: Extract smaller functions
```typescript
// Before: 600-line function
async distributeRewards(cycle, delegators) {
  // ... 600 lines
}

// After: Decomposed
async distributeRewards(cycle: number) {
  const delegators = await this.fetchDelegators(cycle);
  const batch = await this.buildPaymentBatch(delegators);
  const result = await this.sendBatch(batch);
  await this.updateDatabase(cycle, result);

  if (this.bondPoolEnabled) {
    await this.distributeBondPool(cycle, result.totalPaid);
  }
}

private async buildPaymentBatch(delegators) { ... }
private async sendBatch(batch) { ... }
// ... other extracted methods
```

---

### 24. Inconsistent Naming Conventions

**Severity**: LOW

**Examples**:
- `getSettings` vs `get_local_delegators`
- `createScheduledTask` vs `pauseScheduledTask`
- Mix of camelCase and snake_case

**Migration Fix**: Enforce consistent naming with ESLint
```json
{
  "rules": {
    "camelcase": ["error", { "properties": "always" }]
  }
}
```

---

### 25. No API Documentation

**Severity**: MEDIUM

**Issue**: No documentation for endpoints or functions

**Migration Fix**: OpenAPI/Swagger with NestJS
```typescript
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  @ApiOperation({ summary: 'Get payment history' })
  @ApiResponse({
    status: 200,
    description: 'Payment history retrieved',
    type: [PaymentDto],
  })
  @Get()
  async getPayments() {
    // ...
  }
}

// Auto-generates interactive API docs at /api/docs
```

---

## Summary of Critical Issues

| Issue | Severity | Effort to Fix | Priority |
|-------|----------|---------------|----------|
| No unit testing | HIGH | High | P1 |
| Weak password hashing | HIGH | Low | P1 |
| Secrets in source code | HIGH | Low | P1 |
| Weak passphrase encryption | HIGH | Medium | P1 |
| No separation of concerns | HIGH | High | P2 |
| No error handling standards | MEDIUM | Medium | P2 |
| No logging framework | MEDIUM | Low | P2 |
| N+1 query problem | MEDIUM | Low | P2 |
| No database indexes | MEDIUM | Low | P2 |
| No rate limiting | MEDIUM | Low | P3 |
| Session-based auth | MEDIUM | Medium | P3 |
| File-based wallet storage | MEDIUM | Medium | P3 |

---

## Technical Debt Metrics

### Code Complexity
- **Cyclomatic Complexity**: High (distributeRewards: ~50)
- **Function Length**: Very High (600+ lines)
- **Code Duplication**: Medium (validation logic repeated)

### Test Coverage
- **Unit Tests**: 0%
- **Integration Tests**: 0%
- **E2E Tests**: 0%

### Dependencies
- **Outdated Dependencies**: 2 (jQuery, Bootstrap)
- **Security Vulnerabilities**: Low (well-maintained base)
- **License Issues**: None

### Documentation
- **API Documentation**: None
- **Code Comments**: Low (~5% of lines)
- **Architecture Docs**: None (until this migration doc)

---

## Recommendations for Migration

1. **Phase 1**: Address P1 security issues immediately
   - Move secrets to environment variables
   - Implement bcrypt for passwords
   - Improve passphrase encryption

2. **Phase 2**: Improve architecture
   - Separate concerns (MVC)
   - Add comprehensive tests
   - Implement proper logging

3. **Phase 3**: Performance optimizations
   - Add database indexes
   - Implement caching
   - Fix N+1 queries

4. **Phase 4**: Scalability improvements
   - Switch to JWT auth
   - Use secret management service
   - Implement rate limiting

---

*This technical debt analysis should guide refactoring priorities during the TypeScript migration.*
