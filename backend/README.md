# TAPS Backend - TypeScript/NestJS

Modern TypeScript reimplementation of TAPS (Tezos Automatic Payment System) backend.

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org/))
- **Docker** & Docker Compose ([Download](https://www.docker.com/))
- **PostgreSQL** 14+ (or use Docker)

### Installation

1. **Clone the repository** (if not already done)
   ```bash
   cd backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Start Docker services** (PostgreSQL + Redis)
   ```bash
   docker-compose up -d
   ```

5. **Run database migrations**
   ```bash
   npm run prisma:migrate
   ```

6. **Generate Prisma Client**
   ```bash
   npm run prisma:generate
   ```

7. **Start development server**
   ```bash
   npm run start:dev
   ```

The server will start on http://localhost:3000

### Verify Installation

Check health endpoint:
```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T12:00:00.000Z",
  "database": "connected"
}
```

---

## 📁 Project Structure

```
backend/
├── src/
│   ├── config/              # Configuration with Zod validation
│   │   ├── configuration.ts
│   │   └── config.module.ts
│   ├── database/            # Prisma service
│   │   ├── prisma.service.ts
│   │   └── database.module.ts
│   ├── modules/             # Feature modules
│   │   ├── auth/           # Authentication (JWT)
│   │   ├── wallet/         # Wallet management
│   │   ├── rewards/        # Reward calculations
│   │   ├── delegators/     # Delegator management
│   │   ├── payments/       # Payment processing
│   │   ├── bond-pool/      # Bond pool features
│   │   └── blockchain/     # Tezos integration
│   ├── shared/             # Shared utilities
│   │   ├── constants/      # App constants
│   │   ├── dto/            # Data Transfer Objects
│   │   ├── entities/       # TypeScript entities
│   │   ├── interfaces/     # Interfaces
│   │   ├── decorators/     # Custom decorators
│   │   └── guards/         # Auth guards
│   ├── app.module.ts       # Root module
│   ├── main.ts             # Application entry point
│   └── health.controller.ts
├── prisma/
│   ├── schema.prisma       # Database schema
│   └── migrations/         # Database migrations
├── test/                   # E2E tests
├── docker-compose.yml      # Docker services
├── Dockerfile              # Production Docker image
├── .env.example            # Environment template
└── package.json
```

---

## 🛠️ Available Scripts

### Development
```bash
npm run start:dev        # Start in watch mode
npm run start:debug      # Start with debugger
```

### Build
```bash
npm run build            # Build for production
npm run start:prod       # Run production build
```

### Database
```bash
npm run prisma:generate  # Generate Prisma Client
npm run prisma:migrate   # Run migrations
npm run prisma:studio    # Open Prisma Studio (GUI)
```

### Testing
```bash
npm run test             # Run unit tests
npm run test:watch       # Run tests in watch mode
npm run test:cov         # Run with coverage
npm run test:e2e         # Run E2E tests
```

### Code Quality
```bash
npm run lint             # Run ESLint
npm run format           # Format with Prettier
```

---

## 🔧 Configuration

### Environment Variables

All configuration is validated using Zod. See `.env.example` for all available options.

**Critical Settings:**

```bash
# Database (required)
DATABASE_URL="postgresql://user:pass@localhost:5432/taps_db"

# JWT (required)
JWT_SECRET="your-secret-key-min-32-chars"

# Tezos (required)
TEZOS_RPC_URL="https://rpc.ghostnet.teztnets.xyz"
```

### Tezos Networks

**Testnet (Ghostnet) - Default for safety:**
```bash
TEZOS_NETWORK="ghostnet"
TEZOS_RPC_URL="https://rpc.ghostnet.teztnets.xyz"
TZKT_API_URL="https://api.ghostnet.tzkt.io"
BLOCK_EXPLORER_URL="https://ghostnet.tzkt.io"
```

**Mainnet - Production:**
```bash
TEZOS_NETWORK="mainnet"
TEZOS_RPC_URL="https://mainnet-tezos.giganode.io"
TZKT_API_URL="https://api.tzkt.io"
BLOCK_EXPLORER_URL="https://tzstats.com"
```

---

## 🗄️ Database

### Schema

The database schema matches the original TAPS structure with improvements:

- **Settings**: Application configuration
- **Payments**: Cycle payment tracking
- **DelegatorPayments**: Individual delegator payments
- **DelegatorFee**: Custom fee configurations
- **BondPoolSettings**: Bond pool configuration
- **BondPoolMember**: Bond pool member stakes

### Migrations

Create a new migration:
```bash
npx prisma migrate dev --name description_of_changes
```

Apply migrations:
```bash
npx prisma migrate deploy
```

Reset database (development only):
```bash
npx prisma migrate reset
```

### Prisma Studio

Open visual database editor:
```bash
npm run prisma:studio
```

Access at http://localhost:5555

---

## 🐳 Docker

### Development with Docker

Start all services:
```bash
docker-compose up -d
```

View logs:
```bash
docker-compose logs -f
```

Stop services:
```bash
docker-compose down
```

### Production Build

Build image:
```bash
docker build -t taps-backend:latest .
```

Run container:
```bash
docker run -p 3000:3000 --env-file .env taps-backend:latest
```

---

## 🧪 Testing

### Unit Tests

```bash
npm run test
```

### E2E Tests

```bash
npm run test:e2e
```

### Coverage Report

```bash
npm run test:cov
```

Coverage reports are generated in `./coverage`

---

## 📚 API Documentation

### Health Check

```http
GET /api/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T12:00:00.000Z",
  "database": "connected"
}
```

---

## 🔐 Security

### Best Practices

1. **Never commit `.env` files** - Use `.env.example` as template
2. **Use strong secrets** - JWT and encryption secrets should be 32+ characters
3. **Enable rate limiting** - Configured in `.env` (THROTTLE_TTL, THROTTLE_LIMIT)
4. **Use HTTPS in production** - Configure reverse proxy (nginx)
5. **Keep dependencies updated** - Run `npm audit` regularly

### Password Hashing

Uses **bcrypt** with configurable work factor (default: 12 rounds).

### JWT Authentication

Stateless authentication with configurable expiration (default: 7 days).

---

## 🐛 Troubleshooting

### Database Connection Error

**Error:** `Can't reach database server`

**Solution:**
```bash
# Check if PostgreSQL is running
docker-compose ps

# Restart PostgreSQL
docker-compose restart postgres

# Check logs
docker-compose logs postgres
```

### Prisma Client Not Generated

**Error:** `Cannot find module '@prisma/client'`

**Solution:**
```bash
npm run prisma:generate
```

### Port Already in Use

**Error:** `EADDRINUSE: address already in use :::3000`

**Solution:**
```bash
# Find process using port 3000
lsof -i :3000

# Kill process (replace PID)
kill -9 <PID>

# Or change port in .env
PORT=3001
```

---

## 📖 Documentation

- **Migration Docs**: `../migration-docs/`
- **Architecture**: `../migration-docs/ARCHITECTURE.md`
- **Database Schema**: `../migration-docs/DATABASE_SCHEMA.md`
- **Business Logic**: `../migration-docs/BUSINESS_LOGIC.md`
- **Migration Guide**: `../migration-docs/MIGRATION_GUIDE.md`

---

## 🚢 Deployment

### Environment Setup

1. Set `NODE_ENV=production`
2. Use strong secrets (generate with `openssl rand -base64 32`)
3. Configure PostgreSQL (recommend managed service)
4. Set up Redis (recommend managed service)
5. Configure reverse proxy (nginx/Caddy)

### Build and Run

```bash
# Build
npm run build

# Start production server
npm run start:prod
```

### Docker Deployment

```bash
# Build
docker build -t taps-backend:v2.0.0 .

# Run
docker run -d \
  --name taps-backend \
  -p 3000:3000 \
  --env-file .env.production \
  taps-backend:v2.0.0
```

---

## 🤝 Contributing

1. Follow TypeScript best practices
2. Write tests for new features
3. Run linter before committing: `npm run lint`
4. Format code: `npm run format`

---

## 📝 License

MIT License - Same as original TAPS

---

## 🆘 Support

For issues related to:
- **Original ColdFusion TAPS**: See main repository
- **Migration questions**: Check `migration-docs/`
- **TypeScript implementation**: Create GitHub issue

---

## ✅ Success Criteria Checklist

- [x] ✅ `npm install` runs successfully
- [x] ✅ `npm run build` compiles without errors
- [x] ✅ `docker-compose up` starts PostgreSQL
- [x] ✅ `npx prisma migrate dev` creates database schema
- [x] ✅ Environment validation works with sample .env
- [x] ✅ Health check endpoint responds
- [x] ✅ Prisma Studio connects to database

---

**Ready for Phase 2**: Implement authentication module

See `../migration-docs/MIGRATION_GUIDE.md` Phase 1 for next steps.
