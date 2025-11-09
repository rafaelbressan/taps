# TypeScript Migration Guide

## Executive Summary

This guide provides a comprehensive strategy for migrating TAPS from ColdFusion (CFML) to TypeScript/Node.js. The migration complexity is **MEDIUM-HIGH** due to:

- Blockchain integration with Tezos (requires equivalent libraries)
- Complex reward calculation logic
- Scheduled task system
- Session-based security model
- File-based cryptographic wallet storage

**Estimated Effort**: 8-12 weeks (1-2 developers)

**Recommended Approach**: **Phased Rewrite** with parallel operation during transition

---

## Migration Strategy Overview

### Approach: Modern Full-Stack Rewrite

```mermaid
graph LR
    A[ColdFusion Monolith] --> B[Phase 1: API Backend]
    B --> C[Phase 2: Frontend SPA]
    C --> D[Phase 3: Background Jobs]
    D --> E[Phase 4: Testing & Cutover]

    style A fill:#f99
    style E fill:#9f9
```

---

## Phase 1: Backend API (Weeks 1-4)

### 1.1 Technology Stack Recommendations

#### Core Framework
**Recommended**: **NestJS** (TypeScript-first, enterprise-grade)

**Why NestJS**:
- Built-in dependency injection
- Excellent TypeScript support
- Module-based architecture (matches CFC structure)
- Built-in support for scheduled tasks, validation, guards
- OpenAPI/Swagger integration
- Active community and extensive documentation

**Alternative**: Express + TypeScript (lighter weight, more manual setup)

#### Database
**Recommended**: **PostgreSQL 14+**

**Why PostgreSQL**:
- Production-grade, reliable
- Excellent TypeScript ORM support (TypeORM, Prisma)
- JSON/JSONB support for flexible configuration
- Better performance than H2 for concurrent access
- Migration path from H2

**Migration Tool**: Use H2's CSV export → PostgreSQL import

#### ORM
**Recommended**: **Prisma** (modern, type-safe)

**Why Prisma**:
- Auto-generated TypeScript types from schema
- Intuitive query API
- Built-in migrations
- Excellent documentation

**Alternative**: TypeORM (more traditional, similar to Java ORMs)

---

### 1.2 Project Structure

```
taps-backend/
├── src/
│   ├── main.ts                     # Application entry point
│   ├── app.module.ts               # Root module
│   ├── config/                     # Configuration
│   │   ├── database.config.ts
│   │   ├── tezos.config.ts
│   │   └── app.config.ts
│   ├── modules/
│   │   ├── auth/                   # Authentication module
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.module.ts
│   │   │   ├── guards/
│   │   │   │   └── jwt-auth.guard.ts
│   │   │   └── strategies/
│   │   │       └── jwt.strategy.ts
│   │   ├── settings/               # Settings management
│   │   │   ├── settings.controller.ts
│   │   │   ├── settings.service.ts
│   │   │   ├── settings.module.ts
│   │   │   └── dto/
│   │   ├── wallet/                 # Wallet operations
│   │   │   ├── wallet.controller.ts
│   │   │   ├── wallet.service.ts
│   │   │   └── wallet.module.ts
│   │   ├── delegators/             # Delegator management
│   │   │   ├── delegators.controller.ts
│   │   │   ├── delegators.service.ts
│   │   │   └── delegators.module.ts
│   │   ├── payments/               # Payment processing
│   │   │   ├── payments.controller.ts
│   │   │   ├── payments.service.ts
│   │   │   ├── payments.module.ts
│   │   │   └── jobs/
│   │   │       └── distribute-rewards.job.ts
│   │   ├── bond-pool/              # Bond pool management
│   │   │   ├── bond-pool.controller.ts
│   │   │   ├── bond-pool.service.ts
│   │   │   └── bond-pool.module.ts
│   │   └── tezos/                  # Tezos blockchain integration
│   │       ├── tezos.service.ts
│   │       ├── tezos.module.ts
│   │       ├── providers/
│   │       │   ├── rpc.provider.ts
│   │       │   └── tzkt.provider.ts
│   │       └── wallet/
│   │           └── tezos-wallet.service.ts
│   ├── common/
│   │   ├── decorators/
│   │   ├── filters/
│   │   ├── interceptors/
│   │   └── pipes/
│   └── database/
│       ├── entities/               # Database entities
│       │   ├── settings.entity.ts
│       │   ├── payment.entity.ts
│       │   ├── delegator-payment.entity.ts
│       │   ├── delegator-fee.entity.ts
│       │   ├── bond-pool.entity.ts
│       │   └── bond-pool-settings.entity.ts
│       ├── migrations/             # Database migrations
│       └── seeds/                  # Seed data
├── prisma/
│   └── schema.prisma               # Prisma schema
├── test/
│   ├── unit/
│   └── integration/
├── package.json
├── tsconfig.json
└── .env.example
```

---

### 1.3 ColdFusion → TypeScript Component Mapping

| ColdFusion Component | TypeScript Equivalent | NestJS Module |
|---------------------|----------------------|---------------|
| `application.cfc` | `app.module.ts` + `main.ts` | Core |
| `components/taps.cfc` | `PaymentsService` + Jobs | payments |
| `components/database.cfc` | Prisma + Repository pattern | database |
| `components/tezosGateway.cfc` | `TezosService` + Providers | tezos |
| `components/environment.cfc` | Prisma migrations | database |
| `components/barcode.cfc` | `qrcode` npm package | common/utils |

---

### 1.4 Key Libraries & Replacements

| ColdFusion Feature | TypeScript Replacement | Package |
|-------------------|----------------------|---------|
| **Blockchain** |
| TezosJ SDK (Java) | Taquito | `@taquito/taquito` |
| - | Taquito Signer | `@taquito/signer` |
| **Database** |
| H2 Database | PostgreSQL | `pg` |
| cfquery | Prisma ORM | `@prisma/client` |
| **Authentication** |
| cflogin | JWT strategy | `@nestjs/jwt`, `@nestjs/passport` |
| SHA-512 hash | bcrypt (better) | `bcrypt` |
| **Scheduling** |
| cfschedule | Bull Queue | `@nestjs/bull`, `bull` |
| **HTTP Requests** |
| cfhttp | Axios | `axios` |
| **Cryptography** |
| encrypt/decrypt | Node crypto | Built-in `crypto` module |
| **QR Codes** |
| ZXing (Java) | qrcode | `qrcode` |
| **Validation** |
| Manual checks | class-validator | `class-validator` |
| **Configuration** |
| Application vars | Config module | `@nestjs/config` |

---

### 1.5 Tezos Integration with Taquito

#### Install Taquito

```bash
npm install @taquito/taquito @taquito/signer @taquito/utils
```

#### Example: TezosWalletService

```typescript
// src/modules/tezos/wallet/tezos-wallet.service.ts

import { Injectable } from '@nestjs/common';
import { TezosToolkit } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
import { importKey } from '@taquito/signer';

@Injectable()
export class TezosWalletService {
  private tezos: TezosToolkit;

  constructor(
    private configService: ConfigService,
  ) {
    const rpcUrl = this.configService.get('TEZOS_RPC_URL');
    this.tezos = new TezosToolkit(rpcUrl);
  }

  /**
   * Import wallet from mnemonic
   */
  async importWallet(mnemonic: string, passphrase: string): Promise<string> {
    const signer = await InMemorySigner.fromMnemonic({
      mnemonic,
      password: passphrase,
    });

    this.tezos.setProvider({ signer });

    return await signer.publicKeyHash();
  }

  /**
   * Get wallet balance
   */
  async getBalance(address: string): Promise<number> {
    const balance = await this.tezos.tz.getBalance(address);
    return balance.toNumber() / 1_000_000; // Convert mutez to tez
  }

  /**
   * Send batch transaction (equivalent to TezosJ flushTransactionBatch)
   */
  async sendBatchTransaction(
    recipients: { address: string; amount: number }[],
  ): Promise<{ hash: string; confirmed: boolean }> {
    const batch = this.tezos.wallet.batch();

    recipients.forEach(({ address, amount }) => {
      batch.withTransfer({
        to: address,
        amount: amount, // Amount in tez
      });
    });

    const operation = await batch.send();

    // Wait for confirmation (default: 1 confirmation)
    const confirmation = await operation.confirmation(3); // Wait for 3 confirmations

    return {
      hash: operation.opHash,
      confirmed: confirmation !== undefined,
    };
  }

  /**
   * Send single transaction
   */
  async sendTransaction(
    to: string,
    amount: number,
  ): Promise<string> {
    const operation = await this.tezos.wallet
      .transfer({
        to,
        amount,
      })
      .send();

    await operation.confirmation();

    return operation.opHash;
  }
}
```

---

#### Example: TzKT API Provider

```typescript
// src/modules/tezos/providers/tzkt.provider.ts

import { Injectable } from '@nestjs/common';
import axios from 'axios';

interface BakerReward {
  cycle: number;
  stakingBalance: number;
  delegatedBalance: number;
  ownBlockRewards: number;
  endorsementRewards: number;
  // ... other fields
}

interface DelegatorReward {
  address: string;
  balance: number;
  currentBalance: number;
}

@Injectable()
export class TzKtProvider {
  private readonly baseUrl = 'https://api.tzkt.io/v1';

  /**
   * Get baker rewards
   */
  async getBakerRewards(bakerId: string): Promise<BakerReward[]> {
    const response = await axios.get(
      `${this.baseUrl}/rewards/bakers/${bakerId}`,
    );
    return response.data;
  }

  /**
   * Get delegator rewards split for a cycle
   */
  async getDelegatorRewardsSplit(
    bakerId: string,
    cycle: number,
  ): Promise<{
    stakingBalance: number;
    delegators: DelegatorReward[];
    totalRewards: number;
  }> {
    const response = await axios.get(
      `${this.baseUrl}/rewards/split/${bakerId}/${cycle}`,
    );
    return response.data;
  }
}
```

---

### 1.6 Database Schema with Prisma

#### schema.prisma

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Settings {
  bakerId              String   @id @map("baker_id") @db.VarChar(50)
  defaultFee           Decimal  @map("default_fee") @db.Decimal(6, 2)
  updateFreq           Int      @map("update_freq")
  userName             String?  @map("user_name") @db.VarChar(100)
  passHash             String?  @map("pass_hash") @db.VarChar(150)
  applicationPort      Int      @map("application_port")
  mode                 String?  @db.VarChar(20)
  hashSalt             String?  @map("hash_salt") @db.VarChar(150)
  walletHash           String?  @map("wallet_hash") @db.VarChar(150)
  walletSalt           String?  @map("wallet_salt") @db.VarChar(150)
  encryptedPassphrase  String?  @map("encrypted_passphrase") @db.VarChar(255)
  provider             String   @db.VarChar(70)
  gasLimit             Int      @map("gas_limit") @default(15400)
  storageLimit         Int      @map("storage_limit") @default(300)
  transactionFee       Decimal  @map("transaction_fee") @db.Decimal(20, 6) @default(0.001800)
  blockExplorer        String   @map("block_explorer") @db.VarChar(70)
  numBlocksWait        Int      @map("num_blocks_wait") @default(8)
  paymentRetries       Int      @map("payment_retries") @default(1)
  minBetweenRetries    Int      @map("min_between_retries") @default(1)

  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  payments             Payment[]
  delegatorsFees       DelegatorFee[]
  bondPoolSettings     BondPoolSettings?

  @@map("settings")
}

model Payment {
  id              Int      @id @default(autoincrement())
  bakerId         String   @map("baker_id") @db.VarChar(50)
  cycle           Int
  date            DateTime @db.Date
  result          String   @db.VarChar(20)
  total           Decimal  @db.Decimal(20, 6)
  transactionHash String?  @map("transaction_hash") @db.VarChar(70)

  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  settings        Settings @relation(fields: [bakerId], references: [bakerId], onDelete: Cascade)

  @@unique([bakerId, cycle, date, result])
  @@index([cycle])
  @@index([result])
  @@map("payments")
}

model DelegatorPayment {
  id              Int      @id @default(autoincrement())
  bakerId         String   @map("baker_id") @db.VarChar(50)
  cycle           Int
  address         String   @db.VarChar(50)
  date            DateTime @db.Date
  result          String   @db.VarChar(20)
  total           Decimal  @db.Decimal(20, 6)
  transactionHash String?  @map("transaction_hash") @db.VarChar(70)

  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@unique([bakerId, cycle, address, date, result])
  @@index([cycle])
  @@index([address])
  @@index([result])
  @@map("delegators_payments")
}

model DelegatorFee {
  bakerId   String   @map("baker_id") @db.VarChar(50)
  address   String   @db.VarChar(50)
  fee       Decimal  @db.Decimal(6, 2)

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  settings  Settings @relation(fields: [bakerId], references: [bakerId], onDelete: Cascade)

  @@id([bakerId, address])
  @@index([address])
  @@map("delegators_fee")
}

model BondPoolSettings {
  bakerId   String   @id @map("baker_id") @db.VarChar(50)
  status    Boolean

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  settings  Settings @relation(fields: [bakerId], references: [bakerId], onDelete: Cascade)

  @@map("bond_pool_settings")
}

model BondPoolMember {
  bakerId    String   @map("baker_id") @db.VarChar(50)
  address    String   @db.VarChar(50)
  amount     Decimal  @db.Decimal(20, 2)
  name       String?  @db.VarChar(50)
  admCharge  Decimal  @map("adm_charge") @db.Decimal(20, 2)
  isManager  Boolean? @map("is_manager")

  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  @@id([bakerId, address])
  @@map("bond_pool")
}
```

---

### 1.7 Authentication with JWT

#### auth.service.ts

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async validateUser(username: string, password: string): Promise<any> {
    const settings = await this.prisma.settings.findFirst();

    if (!settings) {
      // First-time login
      if (username === 'admin' && password === 'admin') {
        return { username: 'admin' };
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password with bcrypt (better than SHA-512 + salt)
    const isValid = await bcrypt.compare(password, settings.passHash);

    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return { username: settings.userName };
  }

  async login(user: any) {
    const payload = { username: user.username, sub: user.username };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
```

---

### 1.8 Scheduled Jobs with Bull

#### distribute-rewards.job.ts

```typescript
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { PaymentsService } from '../payments.service';

@Processor('payments')
export class DistributeRewardsProcessor {
  constructor(private paymentsService: PaymentsService) {}

  @Process('distribute-rewards')
  async handleDistributeRewards(job: Job) {
    const { cycle, delegators } = job.data;

    await this.paymentsService.distributeRewards(cycle, delegators);
  }
}

// Schedule the blockchain polling job
@Injectable()
export class PaymentsScheduler {
  constructor(
    @InjectQueue('payments') private paymentsQueue: Queue,
    private tezosService: TezosService,
    private prisma: PrismaService,
  ) {}

  @Cron('*/10 * * * *') // Every 10 minutes
  async scheduleFetchBlockchain() {
    const settings = await this.prisma.settings.findFirst();

    if (!settings || settings.mode === 'off') {
      return;
    }

    const rewards = await this.tezosService.getRewards(settings.bakerId);
    const networkPendingCycle = this.getNetworkPendingCycle(rewards);
    const localPendingCycle = await this.getLocalPendingCycle(settings.bakerId);

    if (networkPendingCycle > localPendingCycle) {
      // Cycle changed - trigger distribution
      const delegators = await this.tezosService.getDelegators(
        settings.bakerId,
        localPendingCycle,
      );

      await this.paymentsQueue.add('distribute-rewards', {
        cycle: localPendingCycle,
        delegators,
      });
    }
  }
}
```

---

## Phase 2: Frontend SPA (Weeks 5-7)

### 2.1 Technology Stack

**Recommended**: **React** + **TypeScript** + **Vite**

**UI Library**: **Material-UI (MUI)** or **Ant Design**

**State Management**: **React Query** (for server state) + **Zustand** (for client state)

**Form Handling**: **React Hook Form** + **Zod** (validation)

**Routing**: **React Router v6**

---

### 2.2 Project Structure

```
taps-frontend/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/                        # API client
│   │   ├── client.ts               # Axios instance
│   │   ├── auth.api.ts
│   │   ├── wallet.api.ts
│   │   ├── payments.api.ts
│   │   └── ... (other APIs)
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Layout.tsx
│   │   ├── common/
│   │   │   ├── Button.tsx
│   │   │   ├── Table.tsx
│   │   │   └── ... (reusable components)
│   │   └── features/
│   │       ├── wallet/
│   │       ├── delegators/
│   │       ├── payments/
│   │       └── bond-pool/
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx
│   │   ├── Settings.tsx
│   │   ├── Wallet.tsx
│   │   ├── Delegators.tsx
│   │   ├── Payments.tsx
│   │   └── BondPool.tsx
│   ├── hooks/                      # Custom React hooks
│   │   ├── useAuth.ts
│   │   ├── useWallet.ts
│   │   └── ...
│   ├── store/                      # Zustand stores
│   │   └── auth.store.ts
│   ├── types/                      # TypeScript types
│   │   ├── api.types.ts
│   │   └── ...
│   ├── utils/
│   │   ├── formatting.ts
│   │   └── validation.ts
│   └── styles/
│       └── theme.ts
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

### 2.3 Example: React Query Integration

```typescript
// src/hooks/useDelegators.ts

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { delegatorsApi } from '../api/delegators.api';

export function useDelegators() {
  return useQuery({
    queryKey: ['delegators'],
    queryFn: delegatorsApi.getAll,
  });
}

export function useUpdateDelegatorFee() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      address,
      fee,
    }: {
      address: string;
      fee: number;
    }) => delegatorsApi.updateFee(address, fee),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delegators'] });
    },
  });
}
```

---

## Phase 3: Background Jobs & DevOps (Week 8)

### 3.1 Docker Setup

#### Dockerfile (Backend)

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npm run build
RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
```

#### docker-compose.yml

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:14-alpine
    environment:
      POSTGRES_USER: taps
      POSTGRES_PASSWORD: taps_password
      POSTGRES_DB: taps_db
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - '5432:5432'

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'

  backend:
    build:
      context: ./taps-backend
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgresql://taps:taps_password@postgres:5432/taps_db
      REDIS_URL: redis://redis:6379
      JWT_SECRET: your-secret-key
      TEZOS_RPC_URL: https://mainnet-tezos.giganode.io
    ports:
      - '3000:3000'
    depends_on:
      - postgres
      - redis

  frontend:
    build:
      context: ./taps-frontend
      dockerfile: Dockerfile
    ports:
      - '80:80'
    depends_on:
      - backend

volumes:
  postgres_data:
```

---

## Phase 4: Testing & Cutover (Weeks 9-12)

### 4.1 Testing Strategy

#### Unit Tests (Jest)

```typescript
// payments.service.spec.ts

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [PaymentsService, PrismaService],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('calculatePayment', () => {
    it('should calculate payment with default fee', () => {
      const rewards = 5_432_100; // mutez
      const fee = 5; // percent

      const result = service.calculatePayment(rewards, fee);

      expect(result).toBeCloseTo(5.160495);
    });

    it('should handle zero rewards', () => {
      const result = service.calculatePayment(0, 5);
      expect(result).toBe(0);
    });
  });
});
```

#### Integration Tests

```typescript
describe('PaymentsController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/payments (GET)', () => {
    return request(app.getHttpServer())
      .get('/payments')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty('data');
        expect(Array.isArray(res.body.data)).toBe(true);
      });
  });
});
```

---

### 4.2 Data Migration Script

```typescript
// scripts/migrate-from-h2.ts

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as csvParser from 'csv-parser';

const prisma = new PrismaClient();

async function migrateFromH2() {
  // Export H2 data to CSV first (using H2's export tool)
  // Then import into PostgreSQL

  // Settings
  const settings = await readCSV('./exports/settings.csv');
  await prisma.settings.createMany({ data: settings });

  // Payments
  const payments = await readCSV('./exports/payments.csv');
  await prisma.payment.createMany({ data: payments });

  // ... other tables

  console.log('Migration complete');
}

function readCSV(filePath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

migrateFromH2();
```

---

### 4.3 Cutover Plan

**Parallel Operation Period**: 2-4 weeks

1. **Week 9-10**: Deploy new system alongside old
   - Run both systems in parallel
   - New system in "simulation" mode
   - Compare outputs (logs, calculations, database)
   - Fix any discrepancies

2. **Week 11**: Production testing
   - Switch to new system for one baker (if multiple)
   - Monitor closely for one full cycle
   - Validate payments match expected amounts
   - Collect user feedback

3. **Week 12**: Full cutover
   - Switch all traffic to new system
   - Keep old system running (read-only) for one more cycle
   - Decommission old system after validation

---

## Migration Checklist

### Pre-Migration
- [ ] Export H2 database to CSV
- [ ] Backup wallet files
- [ ] Document custom configuration
- [ ] Set up PostgreSQL database
- [ ] Set up Redis for Bull queues

### Backend Development
- [ ] Set up NestJS project
- [ ] Configure Prisma with PostgreSQL
- [ ] Create all entities and migrations
- [ ] Implement authentication (JWT)
- [ ] Implement TezosService with Taquito
- [ ] Implement PaymentsService (reward distribution)
- [ ] Implement BondPoolService
- [ ] Implement WalletService
- [ ] Set up Bull queues for scheduled jobs
- [ ] Implement retry logic
- [ ] Create comprehensive tests (unit + e2e)
- [ ] Set up logging (Winston/Pino)

### Frontend Development
- [ ] Set up React + Vite project
- [ ] Create layout and navigation
- [ ] Implement login page
- [ ] Implement dashboard
- [ ] Implement wallet management
- [ ] Implement delegator management
- [ ] Implement payment history
- [ ] Implement bond pool management
- [ ] Implement settings page
- [ ] Add real-time balance updates (WebSocket)
- [ ] Create responsive design

### DevOps
- [ ] Create Dockerfiles
- [ ] Create docker-compose.yml
- [ ] Set up CI/CD pipeline
- [ ] Configure environment variables
- [ ] Set up monitoring (Prometheus/Grafana)
- [ ] Set up error tracking (Sentry)

### Testing & Validation
- [ ] Unit test coverage > 80%
- [ ] Integration tests for critical paths
- [ ] Manual testing of all features
- [ ] Load testing for scheduled jobs
- [ ] Security audit (dependencies, authentication)
- [ ] Parallel run validation
- [ ] User acceptance testing

### Cutover
- [ ] Run data migration script
- [ ] Verify all data migrated correctly
- [ ] Deploy to production
- [ ] Monitor logs and metrics
- [ ] Validate first payment cycle
- [ ] Collect user feedback
- [ ] Decommission old system

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Taquito incompatibility with TezosJ** | High | Extensive testing in testnet, create adapter layer |
| **Precision loss in calculations** | High | Use `decimal.js` for all financial math, comprehensive unit tests |
| **Data migration errors** | High | Parallel run period, automated comparison scripts |
| **Performance degradation** | Medium | Load testing, database indexing, caching strategy |
| **Security vulnerabilities** | High | Security audit, dependency scanning, penetration testing |
| **Blockchain API changes** | Medium | Use versioned APIs, implement fallback providers |

---

## Post-Migration Improvements

Once migrated, consider these enhancements:

1. **Multi-baker support**: Allow single instance to manage multiple bakers
2. **Real-time notifications**: WebSockets for instant payment status
3. **Advanced reporting**: Charts, graphs, export to Excel
4. **Mobile app**: React Native for iOS/Android
5. **API for delegators**: Allow delegators to check their rewards
6. **Automated testing**: CI/CD with automated tests on every commit
7. **High availability**: Multiple instances behind load balancer
8. **Backup automation**: Automated database backups to cloud storage

---

## Estimated Costs

| Item | Monthly Cost (USD) |
|------|-------------------|
| VPS (4 CPU, 8GB RAM) | $40-80 |
| PostgreSQL managed DB | $15-50 |
| Redis managed | $10-30 |
| Monitoring (Grafana Cloud) | $0-50 |
| Error tracking (Sentry) | $0-25 |
| **Total** | **$65-235/month** |

**Note**: Can run everything on single VPS for ~$40/month (self-hosted).

---

## Recommended Timeline

| Week | Phase | Deliverables |
|------|-------|-------------|
| 1-2 | Backend core | NestJS setup, Prisma, auth, basic CRUD |
| 3-4 | Tezos integration | Taquito integration, payment logic, scheduled jobs |
| 5-6 | Frontend core | React setup, layout, main pages |
| 7 | Frontend features | All features implemented, connected to API |
| 8 | DevOps | Docker, CI/CD, monitoring |
| 9-10 | Testing | Unit/e2e tests, parallel run |
| 11 | Validation | Production testing, bug fixes |
| 12 | Cutover | Full migration, decommission old system |

---

*This migration guide provides a comprehensive roadmap. Adjust timeline and approach based on team size and expertise.*
