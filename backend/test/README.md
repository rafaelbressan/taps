# TAPS Testing Suite

Comprehensive testing suite for the Tezos Automatic Payment System.

## Overview

The test suite covers:
- Unit tests for critical business logic
- Integration tests for end-to-end flows
- API integration tests for all REST endpoints
- Security tests (authentication, authorization, SQL injection, XSS)
- Load/performance tests
- Test fixtures and utilities

## Test Structure

```
test/
├── fixtures/          # Test data fixtures
│   ├── baker.fixture.ts
│   └── delegators.fixture.ts
├── utils/             # Test utilities
│   └── test-helpers.ts
├── unit/              # Unit tests
│   ├── reward-calculator.spec.ts
│   └── tezos-client.spec.ts
├── integration/       # Integration tests
│   └── distribution.e2e-spec.ts
├── api/               # API integration tests
│   ├── auth.api-spec.ts
│   ├── settings.api-spec.ts
│   ├── payments.api-spec.ts
│   └── jobs.api-spec.ts
├── security/          # Security tests
│   └── security.spec.ts
├── load/              # Load testing
│   ├── artillery-config.yml
│   └── k6-load-test.js
└── README.md
```

## Running Tests

### All Tests
```bash
npm test
```

### Unit Tests Only
```bash
npm test -- --testPathPattern=unit
```

### Integration Tests Only
```bash
npm test -- --testPathPattern=integration
```

### API Tests Only
```bash
npm test -- --testPathPattern=api
```

### Security Tests Only
```bash
npm test -- --testPathPattern=security
```

### Watch Mode
```bash
npm run test:watch
```

### Coverage Report
```bash
npm run test:cov
```

### Load Testing (Artillery)
```bash
npm install -g artillery
artillery run test/load/artillery-config.yml
```

### Load Testing (K6)
```bash
# Install k6: https://k6.io/docs/getting-started/installation/
k6 run test/load/k6-load-test.js
```

## Coverage Requirements

### Global Coverage
- Branches: 70%
- Functions: 70%
- Lines: 70%
- Statements: 70%

### Critical Modules (Rewards Services)
- Branches: 80%
- Functions: 80%
- Lines: 80%
- Statements: 80%

## Test Categories

### 1. Unit Tests

#### Reward Calculator Tests
Tests the core reward calculation algorithm against BUSINESS_LOGIC.md examples.

**Key Test Cases:**
- Basic reward calculation (Example 1: 5,432,100 mutez @ 5% fee = 5.160495 XTZ)
- Basic reward calculation (Example 2: 1,000,000 mutez @ 10% fee = 0.90 XTZ)
- Custom fee handling
- Edge cases (zero rewards, 100% fee, 0% fee)
- Large number precision
- Small number precision

**Run:**
```bash
npm test -- reward-calculator
```

#### Tezos Client Tests
Tests RPC interactions, retry logic, and fallback mechanisms.

**Key Test Cases:**
- Balance retrieval
- Retry on network failure (3 attempts)
- Exponential backoff
- Fallback RPC switching
- Error handling (invalid address, timeout, rate limiting)

**Run:**
```bash
npm test -- tezos-client
```

### 2. Integration Tests

#### Distribution End-to-End Tests
Tests the complete distribution workflow from detection to payment.

**Key Test Cases:**
- Full distribution cycle in simulation mode
- Custom fee application
- Minimum payment threshold
- Bond pool distribution
- Error handling
- Payment validation

**Run:**
```bash
npm test -- distribution.e2e
```

### 3. API Integration Tests

Comprehensive API tests for all REST endpoints with authentication, validation, and error handling.

#### Auth API Tests
Tests authentication endpoints including login, logout, password change, and user info.

**Key Test Cases:**
- Successful login with valid credentials
- Failed login with invalid credentials
- JWT token validation
- Password change with current password verification
- User information retrieval
- Wallet passphrase verification
- Security: SQL injection and XSS prevention

**Run:**
```bash
npm test -- auth.api
```

#### Settings API Tests
Tests baker settings management endpoints.

**Key Test Cases:**
- Get current settings
- Update settings (fees, mode, thresholds)
- Update operation mode
- Get system status
- Input validation (fee ranges, decimal precision)
- Security: data isolation between bakers

**Run:**
```bash
npm test -- settings.api
```

#### Payments API Tests
Tests payment history and distribution endpoints.

**Key Test Cases:**
- Paginated payment history
- Filter by status, date range
- Get cycle-specific payments
- Get pending cycle
- Trigger distribution (requires wallet auth)
- Security: baker payment isolation

**Run:**
```bash
npm test -- payments.api
```

#### Jobs API Tests
Tests background job management endpoints.

**Key Test Cases:**
- Trigger cycle check manually
- Trigger balance poll manually
- Get job status
- Initialize job schedules
- Remove job schedules
- HTTP method validation

**Run:**
```bash
npm test -- jobs.api
```

### 4. Security Tests

Comprehensive security testing covering authentication, authorization, injection attacks, and data protection.

**Key Test Areas:**
- JWT authentication enforcement on all protected endpoints
- Authorization and data isolation between bakers
- SQL injection prevention (login, queries, updates)
- XSS prevention (input sanitization, output encoding)
- Input validation (ranges, types, required fields)
- Password security (bcrypt hashing, no plaintext exposure)
- Sensitive data protection (wallet credentials, password hashes)
- Error message security (no system details leaked)

**Run:**
```bash
npm test -- security
```

**Security Test Coverage:**
- 10+ endpoint authentication tests
- 5+ authorization isolation tests
- 20+ SQL injection payloads tested
- 10+ XSS payloads tested
- 15+ input validation tests
- 5+ password security tests
- 5+ sensitive data protection tests

### 5. Load/Performance Tests

Performance and load testing using Artillery and K6 to verify system behavior under load.

#### Artillery Load Tests
YAML-based load testing with multiple phases: warm-up, ramp-up, sustained load, spike, cool-down.

**Test Scenarios:**
- Authentication flow (30% weight)
- Settings management (25% weight)
- Payment history browsing (30% weight)
- Job management (15% weight)

**Performance Thresholds:**
- Max error rate: 1%
- Max response time: 2000ms
- 95th percentile: < 1000ms
- 99th percentile: < 1500ms

**Run:**
```bash
artillery run test/load/artillery-config.yml
```

#### K6 Load Tests
JavaScript-based load testing with detailed metrics and custom thresholds.

**Load Profile:**
- Warm-up: 1min to 10 users
- Ramp-up: 3min to 50 users
- Sustained: 5min at 50 users
- Spike: 1min to 100 users
- Sustained spike: 2min at 100 users
- Cool-down: 1min to 0 users

**Custom Metrics:**
- Login duration
- Settings operation duration
- Payments query duration
- Job trigger duration

**Run:**
```bash
k6 run test/load/k6-load-test.js
```

## Test Fixtures

### Baker Fixture
Sample baker data for testing:
- `testBaker` - Basic baker with default settings
- `testBakerWithWallet` - Baker with wallet credentials
- `testBakerWithoutWallet` - Baker without wallet

### Delegator Fixtures
Sample delegator data:
- `testDelegators` - Array of test delegators with various balances
- `testDelegatorPayments` - Sample payment records
- `mockTzKTDelegatorsResponse` - Mock TzKT API responses

## Test Utilities

### Database Helpers
- `cleanDatabase()` - Clean all test data
- `seedTestBaker()` - Seed baker data
- `seedTestDelegators()` - Seed delegator data

### Mocking Helpers
- `mockTezosRPC()` - Mock Tezos RPC responses
- `mockTzKTAPI()` - Mock TzKT API responses
- `generateTestJWT()` - Generate test JWT tokens

### Comparison Helpers
- `compareDecimals()` - Compare decimal values with tolerance

## Writing New Tests

### Unit Test Template
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { YourService } from '../../src/path/to/service';

describe('YourService', () => {
  let service: YourService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [YourService],
    }).compile();

    service = module.get<YourService>(YourService);
  });

  it('should do something', () => {
    // Arrange
    const input = 'test';

    // Act
    const result = service.doSomething(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

### Integration Test Template
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { YourModule } from '../../src/path/to/module';

describe('Feature (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [YourModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should complete workflow', async () => {
    // Test your workflow
  });
});
```

## Continuous Integration

Tests run automatically on:
- Every commit to feature branches
- Pull request creation
- Pull request updates

### CI Pipeline
1. Install dependencies
2. Run linter
3. Run unit tests
4. Run integration tests
5. Generate coverage report
6. Check coverage thresholds

## Best Practices

### 1. Arrange-Act-Assert Pattern
```typescript
it('should calculate correctly', () => {
  // Arrange
  const input = 100;

  // Act
  const result = service.calculate(input);

  // Assert
  expect(result).toBe(105);
});
```

### 2. Descriptive Test Names
```typescript
// Good
it('should calculate reward correctly for Example 1 from BUSINESS_LOGIC.md', () => {});

// Bad
it('should work', () => {});
```

### 3. Test One Thing
Each test should verify one specific behavior.

### 4. Use Test Fixtures
Reuse test data from fixtures instead of creating inline.

### 5. Mock External Dependencies
Always mock external services (RPC, APIs) in unit tests.

### 6. Clean Up After Tests
Use `afterEach()` to clean up mocks and test data.

## Debugging Tests

### Run Single Test File
```bash
npm test -- path/to/test.spec.ts
```

### Run Single Test Case
```bash
npm test -- -t "test name pattern"
```

### Debug Mode
```bash
npm run test:debug
```

Then attach debugger to Node process.

## Comparison with ColdFusion

The test suite includes comparison tests to verify TypeScript calculations match ColdFusion exactly:

1. Load historical ColdFusion cycle data
2. Run same calculations in TypeScript
3. Compare results with tolerance
4. Verify every delegator payment matches

This ensures 100% parity with the legacy system.

## Performance Testing

Load tests are located in separate directory:
```
test/load/
└── artillery-config.yml
```

Run load tests:
```bash
npm run test:load
```

## Security Testing

Security tests verify:
- JWT authentication enforcement
- Rate limiting
- SQL injection prevention
- XSS prevention
- Input validation

## Troubleshooting

### Tests Failing Due to Database
Ensure PostgreSQL is running:
```bash
docker-compose up postgres
```

### Tests Failing Due to Redis
Ensure Redis is running:
```bash
docker-compose up redis
```

### Coverage Not Meeting Thresholds
Run coverage report to see what's missing:
```bash
npm run test:cov
```

Open `coverage/index.html` in browser for detailed report.

## Contributing

When adding new features:
1. Write tests first (TDD)
2. Ensure coverage meets thresholds
3. Add test cases to relevant suite
4. Update this README if needed

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Testing NestJS](https://docs.nestjs.com/fundamentals/testing)
- [BUSINESS_LOGIC.md](/migration-docs/BUSINESS_LOGIC.md) - Reference for calculation examples
