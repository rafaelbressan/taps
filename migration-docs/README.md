# TAPS - TypeScript Migration Documentation

## Overview

This documentation package provides comprehensive analysis and migration strategy for **TAPS (Tezos Automatic Payment System)**, a ColdFusion application designed to automate reward distribution for Tezos bakers.

**Purpose**: Enable a complete reimplementation in TypeScript/Node.js by documenting all business logic, architecture, database schemas, and technical decisions.

---

## Application Summary

### What is TAPS?

TAPS is a web-based system that:
- Monitors the Tezos blockchain for cycle changes
- Automatically calculates delegator rewards based on staking shares
- Distributes payments via batch transactions
- Manages custom fee structures per delegator
- Supports bond pool reward distribution
- Provides native wallet management
- Offers payment history and reporting

### Key Statistics

| Metric | Value |
|--------|-------|
| **Files** | 29 ColdFusion files (.cfm, .cfc) |
| **Lines of Code** | ~6,000 (estimated) |
| **Database Tables** | 6 tables |
| **External APIs** | 2 (Tezos RPC, TzKT) |
| **Current Stack** | Lucee (CFML), H2 Database, TezosJ SDK (Java) |
| **Proposed Stack** | Node.js, NestJS, PostgreSQL, Taquito |

---

## Key Features

### 1. Automated Reward Distribution
- **Cycle Detection**: Monitors Tezos blockchain via scheduled tasks
- **Payment Calculation**: Applies custom or default fees per delegator
- **Batch Transactions**: Sends all payments in single blockchain operation
- **Retry Logic**: Configurable retries with confirmation waiting

### 2. Native Wallet Management
- **Wallet Creation**: Import from mnemonic + passphrase
- **Encrypted Storage**: Dual encryption (user password + app seed)
- **Balance Checking**: Real-time balance from blockchain
- **Send Funds**: Manual transaction capability

### 3. Delegator Management
- **Custom Fees**: Set individual fee percentages
- **Reward Tracking**: Historical payment records per delegator
- **CSV Export**: Batch payment via CSV upload

### 4. Bond Pool Support
- **Member Management**: Add/remove pool members with stakes
- **Share Calculation**: Proportional distribution based on stakes
- **Admin Fees**: Configurable fees collected by pool manager
- **Automated Distribution**: Runs after delegator payments

### 5. Operation Modes
- **Off**: No blockchain monitoring or payments
- **Simulation**: Calculates and logs without sending transactions
- **On**: Full automation with real blockchain transactions

---

## Documentation Structure

### 📁 Core Documentation

#### [ARCHITECTURE.md](./ARCHITECTURE.md)
**What it covers**:
- High-level system architecture with diagrams
- Component structure and relationships
- Data flow for automated rewards and manual payments
- Session and state management
- Security architecture
- Deployment architecture

**Who should read**: Architects, backend developers, DevOps engineers

---

#### [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md)
**What it covers**:
- Complete database schema with Entity-Relationship diagram
- Table definitions with all columns and types
- Primary keys, foreign keys, and indexes
- Business logic embedded in schema
- Common queries with examples
- Migration recommendations for PostgreSQL

**Who should read**: Database administrators, backend developers

---

#### [API_ENDPOINTS.md](./API_ENDPOINTS.md)
**What it covers**:
- All HTTP endpoints (GET/POST)
- Request/response formats
- Authentication requirements
- Business logic per endpoint
- External API integrations (Tezos RPC, TzKT)
- Session management
- Recommended RESTful API design for migration

**Who should read**: Backend developers, API designers, frontend developers

---

#### [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md)
**What it covers**:
- Core reward distribution algorithm (600+ lines explained)
- Payment calculation formulas with examples
- Custom fee logic
- Bond pool distribution algorithm
- Cycle change detection mechanism
- Wallet authentication
- Batch transaction construction
- Retry and error handling logic
- Validation rules
- Logging and audit trail

**Who should read**: Backend developers, business analysts, QA engineers

---

#### [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
**What it covers**:
- Recommended technology stack (NestJS, React, PostgreSQL, Taquito)
- Phased migration approach (12-week timeline)
- Project structure for backend and frontend
- ColdFusion → TypeScript component mapping
- Complete code examples for all major features
- Taquito integration examples
- Prisma schema definition
- JWT authentication implementation
- Background job setup with Bull
- Docker configuration
- Testing strategy
- Data migration script
- Cutover plan

**Who should read**: Everyone involved in migration

---

#### [DEPENDENCIES.md](./DEPENDENCIES.md)
**What it covers**:
- Current ColdFusion dependencies (Lucee, H2, TezosJ, ZXing)
- External API dependencies (Tezos RPC, TzKT)
- System dependencies (curl, wget)
- Frontend dependencies (jQuery, Bootstrap)
- Replacement NPM packages for TypeScript stack
- Complete package.json for backend and frontend
- License compliance analysis
- Performance comparison
- Security considerations

**Who should read**: DevOps engineers, backend developers, architects

---

#### [TECHNICAL_DEBT.md](./TECHNICAL_DEBT.md)
**What it covers**:
- 25+ identified issues with severity ratings
- Code quality problems (separation of concerns, validation, error handling)
- Architecture issues (monolithic structure, no caching, session-based auth)
- Performance issues (N+1 queries, missing indexes)
- Security issues (weak hashing, hardcoded secrets, no rate limiting)
- Maintainability issues (large functions, inconsistent naming)
- Technical debt metrics
- Prioritized recommendations

**Who should read**: Tech leads, architects, security engineers, QA engineers

---

## Quick Start Guide

### For Business Stakeholders
1. Read this README for high-level understanding
2. Review [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md) to understand how the system works
3. Check [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) for timeline and costs

### For Architects
1. Start with [ARCHITECTURE.md](./ARCHITECTURE.md) for system overview
2. Review [TECHNICAL_DEBT.md](./TECHNICAL_DEBT.md) for improvement opportunities
3. Read [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) for technology recommendations
4. Check [DEPENDENCIES.md](./DEPENDENCIES.md) for infrastructure needs

### For Backend Developers
1. Read [ARCHITECTURE.md](./ARCHITECTURE.md) for component structure
2. Study [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md) for core algorithms
3. Review [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) for data model
4. Use [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) as implementation reference
5. Check [API_ENDPOINTS.md](./API_ENDPOINTS.md) for endpoint specifications

### For Frontend Developers
1. Read [API_ENDPOINTS.md](./API_ENDPOINTS.md) for endpoint contracts
2. Review [ARCHITECTURE.md](./ARCHITECTURE.md) for data flow
3. Check [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) Phase 2 for React setup

### For DevOps Engineers
1. Review [ARCHITECTURE.md](./ARCHITECTURE.md) for deployment requirements
2. Check [DEPENDENCIES.md](./DEPENDENCIES.md) for infrastructure needs
3. Study [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) Phase 3 for Docker setup

### For QA Engineers
1. Read [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md) for test scenarios
2. Review [API_ENDPOINTS.md](./API_ENDPOINTS.md) for endpoint testing
3. Check [TECHNICAL_DEBT.md](./TECHNICAL_DEBT.md) for known issues
4. Study [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) Phase 4 for testing strategy

---

## Key Findings

### Strengths
✅ **Well-defined business logic**: Clear reward calculation and distribution algorithms
✅ **Comprehensive features**: Native wallet, bond pool, custom fees
✅ **Security-conscious**: Uses cfqueryparam to prevent SQL injection
✅ **Batch transactions**: Efficient blockchain operations
✅ **Audit trail**: Complete payment history in database and logs

### Challenges
⚠️ **No test coverage**: Zero unit or integration tests
⚠️ **Outdated dependencies**: jQuery 3.2.1, Bootstrap 3.x
⚠️ **Weak password hashing**: SHA-512 instead of bcrypt
⚠️ **Mixed concerns**: Presentation + business logic + data access in single files
⚠️ **Large functions**: 600+ line functions difficult to maintain
⚠️ **No caching**: Repeated API calls and database queries
⚠️ **Limited scalability**: Session-based auth, file-based wallet storage

### Opportunities
🚀 **Modern stack**: TypeScript, NestJS, React, PostgreSQL
🚀 **Better testing**: Unit, integration, and e2e test coverage
🚀 **Improved security**: bcrypt, JWT, secret management
🚀 **Better architecture**: Separation of concerns, modular design
🚀 **Performance**: Caching, database indexes, connection pooling
🚀 **Scalability**: Stateless auth, horizontal scaling
🚀 **Developer experience**: Type safety, auto-completion, better tooling

---

## Migration Effort Estimate

### Timeline: 8-12 Weeks

| Phase | Duration | Team Size | Deliverable |
|-------|----------|-----------|-------------|
| **Phase 1: Backend API** | 4 weeks | 2 developers | NestJS API with all features |
| **Phase 2: Frontend SPA** | 3 weeks | 1-2 developers | React application |
| **Phase 3: DevOps** | 1 week | 1 DevOps engineer | Docker, CI/CD, monitoring |
| **Phase 4: Testing & Cutover** | 2-4 weeks | Full team | Production-ready system |

### Budget Estimate

**Development**: $60,000 - $100,000 (2 senior developers @ $150-200/day × 60-80 days)

**Infrastructure** (annual): $800 - $3,000
- VPS/Cloud hosting: $40-80/month
- Managed PostgreSQL: $15-50/month
- Monitoring: $0-50/month
- Total: ~$65-235/month

**Total First Year**: $60,800 - $103,000

**ROI**:
- Better maintainability (faster feature development)
- Lower hosting costs (more efficient)
- Easier to find developers (TypeScript vs ColdFusion)
- Better security and reliability

---

## Critical Risks & Mitigation

### Risk 1: Taquito incompatibility with TezosJ
**Impact**: HIGH
**Mitigation**:
- Extensive testing on Tezos testnet
- Create adapter layer for compatibility
- Run parallel systems during transition

### Risk 2: Data migration errors
**Impact**: HIGH
**Mitigation**:
- Automated comparison scripts
- Parallel run period (2-4 weeks)
- Keep old system as backup

### Risk 3: Precision loss in financial calculations
**Impact**: HIGH
**Mitigation**:
- Use decimal.js for all financial math
- Comprehensive unit tests with edge cases
- Validate against existing logs

### Risk 4: Blockchain API changes
**Impact**: MEDIUM
**Mitigation**:
- Use versioned APIs
- Implement fallback providers
- Monitor API deprecation notices

---

## Success Criteria

### Technical
- [ ] 100% feature parity with current system
- [ ] >80% test coverage (unit + integration)
- [ ] <200ms average API response time
- [ ] Zero data loss during migration
- [ ] All payments match current calculations (6 decimal precision)

### Business
- [ ] Zero payment failures after cutover
- [ ] User acceptance testing passed
- [ ] Documentation complete and reviewed
- [ ] Team trained on new system
- [ ] Monitoring and alerting in place

---

## Next Steps

### Immediate Actions
1. **Review documentation**: Stakeholder review of all docs
2. **Validate assumptions**: Confirm business logic understanding
3. **Approve technology stack**: Sign off on NestJS, React, PostgreSQL
4. **Secure budget**: Approve development and infrastructure costs
5. **Form team**: Assign developers and DevOps engineer

### Week 1 Kickoff
1. **Environment setup**: Development, staging, production environments
2. **Repository setup**: Git repos for backend and frontend
3. **CI/CD pipeline**: GitHub Actions or similar
4. **Database setup**: PostgreSQL instance
5. **First sprint planning**: Define Phase 1 tasks

---

## Contact & Questions

For questions about this documentation or the migration project:

- **Business Logic Questions**: Review [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md) first
- **Technical Questions**: Check [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- **Architecture Questions**: See [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Database Questions**: Refer to [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md)

---

## Document Version

**Version**: 1.0
**Date**: 2025-11-09
**Analysis Tool**: Claude Code
**Source**: TAPS ColdFusion codebase (v1.2.3)

---

## Appendix: File Inventory

### ColdFusion Component Files (.cfc)
1. `application.cfc` - Application configuration
2. `components/taps.cfc` - Core business logic (877 lines)
3. `components/database.cfc` - Data access layer (942 lines)
4. `components/tezosGateway.cfc` - Blockchain integration (444 lines)
5. `components/environment.cfc` - Database initialization (130 lines)
6. `components/barcode.cfc` - QR code generation
7. `components/deactivated_tzscan.cfc` - Legacy TzScan integration (deprecated)

### View Files (.cfm)
**Authentication**:
- `index.cfm` - Login page
- `logout.cfm` - Logout handler

**Configuration**:
- `setup.cfm` - Initial setup
- `settings.cfm` - Settings management
- `security.cfm` - Password change

**Core Features**:
- `menu.cfm` - Main navigation
- `wallet.cfm` - Wallet management
- `send_funds.cfm` - Send transactions
- `receive_funds.cfm` - Receive address/QR
- `delegators.cfm` - Delegator management
- `delegation.cfm` - Delegation info
- `payments.cfm` - Payment history
- `rewards.cfm` - Reward display
- `status.cfm` - System status

**Batch Operations**:
- `csvBatch.cfm` - CSV upload
- `csvBatchSend.cfm` - Execute CSV batch

**Bond Pool**:
- `bondpool.cfm` - Bond pool management
- `bp_proxy.cfm` - Bond pool operations proxy

**Reporting**:
- `report_delegate_payments.cfm` - PDF reports
- `fees.cfm` - Fee management

**Background**:
- `script_fetch.cfm` - Scheduled blockchain polling
- `getBalance.cfm` - AJAX balance endpoint

**Utilities**:
- `advanced.cfm` - Advanced settings
- `reset.cfm` - Factory reset

### Supporting Files
- `css/bootstrap.min.css` - UI framework
- `js/jquery-3.2.1.min.js` - JavaScript library
- `lib/tezosj-sdk-plain-java-1.4.0.jar` - Tezos SDK
- `lib/zxing_core.jar` - QR code library
- `lib/zxing_javase.jar` - QR code library

---

## Glossary

**Baker**: A Tezos network validator who creates blocks and earns rewards
**Delegator**: A token holder who delegates their stake to a baker
**Cycle**: Tezos time period (~2.8 days, 4096 blocks)
**Mutez**: Smallest unit of tez (1 tez = 1,000,000 mutez)
**Bond Pool**: Group of stakeholders sharing baker's self-bond rewards
**Batch Transaction**: Multiple transfers in single blockchain operation
**CFML**: ColdFusion Markup Language
**Lucee**: Open-source CFML engine
**Taquito**: TypeScript library for Tezos blockchain

---

*This comprehensive documentation enables a complete TypeScript reimplementation of TAPS. All business logic, technical decisions, and migration strategies are documented in detail.*

**Ready to migrate? Start with [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)**
