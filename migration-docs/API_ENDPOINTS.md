# API Endpoints Documentation

## Overview

TAPS is a server-side rendered web application with form-based interactions. It does not expose a RESTful API but rather uses traditional HTTP GET/POST endpoints for navigation and form submissions.

## Authentication

**Method**: Session-based authentication using ColdFusion `cflogin`
**Session Timeout**: 20 minutes (1200 seconds)
**Protected Routes**: All routes except `index.cfm` require authentication

## Internal Endpoints (User-Facing Pages)

### Authentication Endpoints

#### POST /index.cfm
**Purpose**: User login

**Parameters** (form-encoded):
- `user` (string): Username
- `passdw` (string): Password
- `ok` (string): Submit flag ("1" when submitting)

**Response**:
- Success: Redirect to `menu.cfm` with session established
- Failure: Re-render login page with error message

**Business Logic**:
1. Validates credentials against SHA-512 hash in database
2. Creates session with `cfloginUser`
3. Runs `healthCheck()` to verify system integrity
4. Opens native wallet in background thread (if configured)
5. Sets application-scoped variables from settings

**Example Request**:
```http
POST /taps/index.cfm HTTP/1.1
Content-Type: application/x-www-form-urlencoded

user=admin&passdw=mypassword&ok=1
```

---

#### GET /logout.cfm
**Purpose**: User logout

**Parameters**: None

**Response**: Redirect to `index.cfm` with session destroyed

**Business Logic**:
1. Calls `cflogout` to destroy session
2. Redirects to login page

---

### Navigation Endpoints

#### GET /menu.cfm
**Purpose**: Main navigation menu

**Authentication**: Required

**Response**: HTML menu with links to all features

**Business Logic**:
- Displays application status
- Shows current balance (if wallet configured)
- Provides navigation to all features

---

### Configuration Endpoints

#### GET/POST /setup.cfm
**Purpose**: Initial application setup

**Authentication**: Required

**GET Response**: Setup form

**POST Parameters** (form-encoded):
- `baker` (string): Tezos baker address (tz1...)
- `fee` (number): Default delegator fee percentage
- `freq` (number): Update frequency in minutes
- `user` (string): Admin username
- `passdw` (string): Admin password
- `passdw2` (string): Password confirmation
- `luceePort` (number): Application port
- `tezosClientPath` (string): Legacy field
- `tezosNodeAlias` (string): Legacy field
- `tezosBaseDir` (string): Legacy field
- `optFunding` (string): "native" or "node"
- `isSaving` (string): "1" when submitting

**Response**:
- Success: Congratulations page with setup confirmation
- Failure: Error message

**Business Logic**:
1. Validates all fields (non-empty, numeric where required)
2. Saves settings to database
3. Creates scheduled task for blockchain polling
4. Initializes payment tables

**Example Request**:
```http
POST /taps/setup.cfm HTTP/1.1
Content-Type: application/x-www-form-urlencoded

baker=tz1abc...&fee=5&freq=10&user=admin&passdw=password&passdw2=password&
luceePort=8888&optFunding=native&isSaving=1
```

---

#### GET/POST /settings.cfm
**Purpose**: Modify application settings

**Authentication**: Required

**GET Response**: Settings form pre-populated with current values

**POST Parameters** (form-encoded):
- `bakerID` (string): Baker address
- `proxy_server` (string): Proxy server URL
- `proxy_port` (number): Proxy port
- `provider` (string): Tezos RPC provider URL
- `payment_retries` (number): Number of payment retries
- `gas_limit` (number): Gas limit for transactions
- `storage_limit` (number): Storage limit
- `num_blocks_wait` (number): Blocks to wait for confirmation
- `block_explorer` (string): Block explorer URL
- `min_between_retries` (number): Minutes between retries
- `transaction_fee` (number): Transaction fee in tez
- `default_fee` (number): Default delegator fee %
- `update_freq` (number): Update frequency in minutes
- `lucee_port` (number): Application port

**Response**:
- Success: Confirmation message
- Failure: Error message

**Business Logic**:
- Updates settings in database
- Validates all fields

---

#### GET/POST /security.cfm
**Purpose**: Change admin password

**Authentication**: Required

**POST Parameters** (form-encoded):
- `user` (string): Username
- `current` (string): Current password
- `passdw` (string): New password
- `passdw2` (string): Password confirmation

**Response**:
- Success: Confirmation message
- Failure: Error message

**Business Logic**:
1. Authenticates with current password
2. Validates new password match
3. Generates new SHA-512 hash with new salt
4. Updates database

---

### Wallet Endpoints

#### GET/POST /wallet.cfm
**Purpose**: Native wallet management

**Authentication**: Required

**Sections**:

##### 1. Create Wallet (POST)
**Parameters**:
- `mnemonic_words` (string): 24 mnemonic words
- `passphrase` (string): Wallet passphrase
- `user_passdw` (string): User login password
- `create_wallet` (string): "1" when submitting

**Business Logic**:
1. Creates TezosJ wallet from mnemonic
2. Encrypts passphrase with user password and app seed
3. Saves wallet file to `wallet/wallet.taps`
4. Stores encrypted passphrase in database

##### 2. Import Wallet (POST)
**Parameters**:
- `mnemonic_import` (string): Mnemonic words
- `passphrase_import` (string): Passphrase
- `user_passdw_import` (string): User password
- `import_wallet` (string): "1" when submitting

**Business Logic**:
- Same as create wallet

##### 3. View Balance (GET)
**Response**: Displays wallet address, balance, QR code

**Business Logic**:
- Retrieves balance from `session.myWallet.getBalance()`
- Generates QR code for address

---

#### GET/POST /send_funds.cfm
**Purpose**: Send Tezos from native wallet

**Authentication**: Required

**POST Parameters** (form-encoded):
- `to_address` (string): Recipient address
- `amount` (number): Amount to send in tez
- `passphrase` (string): Wallet passphrase

**Response**:
- Success: Transaction hash and confirmation
- Failure: Error message

**Business Logic**:
1. Authenticates wallet passphrase
2. Initializes TezosJ wallet
3. Calls `wallet.send(to, amount, fee, gasLimit, storageLimit)`
4. Waits for blockchain confirmation
5. Displays result

**Example Request**:
```http
POST /taps/send_funds.cfm HTTP/1.1
Content-Type: application/x-www-form-urlencoded

to_address=tz1recipient...&amount=10.5&passphrase=mypassphrase
```

---

#### GET /receive_funds.cfm
**Purpose**: Display receive address with QR code

**Authentication**: Required

**Response**: HTML page with wallet address and QR code

**Business Logic**:
- Retrieves address from session wallet
- Generates QR code using barcode.cfc

---

#### GET /getBalance.cfm
**Purpose**: AJAX endpoint to get current wallet balance

**Authentication**: Required

**Response**: JSON with balance

**Business Logic**:
- Calls `session.myWallet.getBalance()`
- Returns balance in microtez

**Example Response**:
```json
{
  "balance": "1234567890"
}
```

---

### Delegator Management Endpoints

#### GET/POST /delegators.cfm
**Purpose**: View and manage delegator custom fees

**Authentication**: Required

**GET Response**: Table of all delegators with current fees

**POST Parameters** (form-encoded):
- `address_{delegator_address}` (number): Fee percentage for specific delegator
- Multiple address parameters for bulk update

**Response**:
- Success: Updated fee list
- Failure: Error message

**Business Logic**:
1. Fetches delegator list from TzKT API
2. Retrieves custom fees from database
3. On POST: Updates fees in `delegatorsFee` table
4. Ordered by delegator balance (highest first)

---

#### GET /delegation.cfm
**Purpose**: View delegation information

**Authentication**: Required

**Response**: HTML page with delegation status

**Business Logic**:
- Displays baker's delegation information
- Shows delegators count and total staking balance

---

### Payment & Reward Endpoints

#### GET /payments.cfm
**Purpose**: View payment history

**Authentication**: Required

**Response**: Table of all payments by cycle

**Business Logic**:
- Queries `payments` and `delegatorsPayments` tables
- Displays cycle, date, status, total, transaction hash
- Links to block explorer for transaction details

---

#### GET /rewards.cfm
**Purpose**: View reward calculations

**Authentication**: Required

**Response**: Table of rewards per cycle

**Business Logic**:
- Calls `tezosGateway.getRewards(bakerId)`
- Displays cycle, status, and reward amounts
- Shows pending vs delivered cycles

---

#### GET /report_delegate_payments.cfm
**Purpose**: Generate PDF payment report

**Authentication**: Required

**Parameters** (query string):
- `cycle` (number): Cycle number to report

**Response**: PDF document

**Business Logic**:
- Queries `delegatorsPayments` for specified cycle
- Generates PDF with payment details per delegator
- Uses CFDocument for PDF generation

---

### CSV Batch Payment Endpoints

#### GET/POST /csvBatch.cfm
**Purpose**: Upload CSV file for batch payments

**Authentication**: Required

**GET Response**: CSV upload form with instructions

**POST Parameters** (multipart):
- `csvFile` (file): CSV file with columns: address, amount (in mutez)

**Response**:
- Success: Preview table of parsed payments
- Failure: Error message

**Business Logic**:
1. Parses CSV file
2. Validates addresses and amounts
3. Stores in session for confirmation
4. Displays preview

**CSV Format**:
```csv
address,amount
tz1delegator1...,5000000
tz1delegator2...,3000000
```

---

#### POST /csvBatchSend.cfm
**Purpose**: Execute CSV batch payment

**Authentication**: Required

**POST Parameters** (form-encoded):
- Reads batch from session

**Response**:
- Success: Transaction hash and log file path
- Failure: Error message

**Business Logic**:
1. Retrieves batch from session
2. Calls `taps.sendCustomBatch(batch)`
3. Creates batch transaction with TezosJ
4. Writes log file to `logs/customBatch_{timestamp}.log`
5. Returns transaction hash

---

### Bond Pool Endpoints

#### GET/POST /bondpool.cfm
**Purpose**: Manage bond pool members

**Authentication**: Required

**Sections**:

##### 1. View Members (GET)
**Response**: Table of bond pool members

##### 2. Add Member (POST)
**Parameters**:
- `address` (string): Member address
- `amount` (number): Stake amount
- `name` (string): Display name
- `fee` (number): Administrative fee %
- `ismanager` (string): "on" if manager

**Business Logic**:
- Validates address and amounts
- If `ismanager=on`, clears other managers
- Inserts into `bondPool` table

##### 3. Update Member (POST)
**Parameters**: Same as add, plus operation flag

**Business Logic**:
- Updates existing member record

##### 4. Delete Member (POST)
**Parameters**:
- `address` (string): Member to remove

**Business Logic**:
- Deletes from `bondPool` table

##### 5. Enable/Disable Bond Pool (POST)
**Parameters**:
- `bond_pool_status` (boolean): Enable/disable

**Business Logic**:
- Updates `bondPoolSettings.status`

---

#### POST /bp_proxy.cfm
**Purpose**: Proxy for bond pool operations (add/update/delete)

**Authentication**: Required

**Parameters** (form-encoded):
- `address` (string): Member address
- `amount` (number): Stake amount
- `name` (string): Display name
- `fee` (number): Fee percentage
- `ismanager` (string): Manager flag
- `operation` (string): "add", "update", or "delete"

**Response**: Success/failure message

**Business Logic**:
- Routes to `database.bondPoolMemberProxy()`
- Performs requested operation

---

### Status & Monitoring Endpoints

#### GET /status.cfm
**Purpose**: System status dashboard

**Authentication**: Required

**Response**: Status page with:
- Current operation mode (Off/Simulation/On)
- Current cycle
- Pending rewards cycle
- Last fetch time
- Wallet balance
- Scheduled task status

**Business Logic**:
- Queries database for current state
- Calls TezosGateway for blockchain data
- Displays scheduled task info

**Mode Toggle** (POST):
**Parameters**:
- `mode` (number): 0=Off, 1=Simulation, 2=On

**Business Logic**:
1. Updates `settings.mode`
2. Pauses/resumes scheduled task
3. Returns to status page

---

### Background Endpoints (Not User-Facing)

#### GET /script_fetch.cfm
**Purpose**: Scheduled task endpoint for blockchain polling

**Authentication**: None (called by scheduler)

**Response**: Status message

**Business Logic**:
1. Calls `tezosGateway.getRewards(bakerId)`
2. Calls `tezosGateway.getDelegators(bakerId, fromCycle, toCycle)`
3. Compares network pending cycle vs local pending cycle
4. If cycle changed: Calls `taps.distributeRewards()`
5. Updates database with latest delegator information
6. Stores delegator fees for new delegators

**Execution Frequency**: Every N minutes (configured in settings)

**Critical Path**:
```
1. Fetch rewards from TzKT API
2. Identify pending rewards cycle
3. Check local database for pending cycle
4. If mismatch (cycle changed):
   - Fetch delegator list for old cycle
   - Calculate shares and rewards
   - Distribute payments (if mode=ON)
   - Update bond pool (if enabled)
   - Mark cycle as completed
   - Insert new pending cycle
5. Store delegator data for all known cycles
```

---

### Utility Endpoints

#### GET /advanced.cfm
**Purpose**: Advanced settings (currently minimal)

**Authentication**: Required

**Response**: Advanced configuration options

---

#### GET/POST /reset.cfm
**Purpose**: Factory reset TAPS

**Authentication**: Required

**POST Parameters** (form-encoded):
- `user` (string): Username
- `passdw` (string): Password
- `passdw2` (string): Password confirmation

**Response**:
- Success: Reset confirmation, redirect to login
- Failure: Error message

**Business Logic**:
1. Authenticates user
2. Deletes scheduled task
3. Deletes all database records
4. Clears application variables
5. Does NOT delete wallet file or logs

---

#### GET /fees.cfm
**Purpose**: Fee management interface

**Authentication**: Required

**Response**: Fee configuration page

**Business Logic**:
- Manages delegator fees
- Similar to delegators.cfm

---

## External API Dependencies

### Tezos RPC API

TAPS integrates with Tezos node RPC endpoints:

#### GET {provider}/chains/main/blocks/head/metadata
**Purpose**: Get current blockchain HEAD information

**Response**: JSON with cycle, level, and metadata

**Used By**: `tezosGateway.getHead()`

---

#### GET {provider}/chains/main/blocks/head/context/constants
**Purpose**: Get blockchain constants

**Response**: JSON with blocks_per_cycle, preserved_cycles, etc.

**Used By**: `tezosGateway.getConstants()`

---

### TzKT API

#### GET https://api.tzkt.io/v1/rewards/bakers/{baker_id}
**Purpose**: Get baker rewards by cycle

**Response**: JSON array of cycles with reward information

**Example Response**:
```json
[
  {
    "cycle": 500,
    "stakingBalance": 1000000000000,
    "delegatedBalance": 900000000000,
    "numDelegators": 150,
    "ownBlockRewards": 5000000,
    "endorsementRewards": 10000000,
    ...
  }
]
```

**Used By**: `tezosGateway.getRewards()`

---

#### GET https://api.tzkt.io/v1/rewards/split/{baker_id}/{cycle}
**Purpose**: Get delegator reward distribution for a cycle

**Response**: JSON with delegator array and reward breakdown

**Example Response**:
```json
{
  "cycle": 500,
  "stakingBalance": 1000000000000,
  "delegators": [
    {
      "address": "tz1...",
      "balance": 50000000000,
      "currentBalance": 50000000000
    }
  ],
  "ownBlockRewards": 5000000,
  "endorsementRewards": 10000000,
  ...
}
```

**Used By**: `tezosGateway.getDelegators()`

---

## Session & State Management

### Session Variables
- `session.user`: Authenticated username
- `session.myWallet`: TezosJ wallet object
- `session.tezosJ`: TezosJ SDK instance
- `session.totalAvailable`: Cached balance
- `session.csvBatch`: Temporary storage for CSV batch payments

### Application Variables
- `application.bakerId`: Current baker ID
- `application.fee`: Default fee
- `application.freq`: Fetch frequency
- `application.provider`: RPC provider URL
- `application.port`: Server port

---

## Error Responses

All endpoints return HTML error messages inline. No structured JSON error responses.

**Common Error Scenarios**:
- Authentication failure: Redirect to login
- Validation error: Re-render form with error message
- Database error: Display error message
- Blockchain error: Display error with transaction details

---

## Migration Recommendations

For TypeScript/Node.js migration:

1. **Convert to RESTful API**:
   - Separate frontend (React/Vue) from backend (Express/NestJS)
   - Create JSON API endpoints
   - Implement JWT authentication

2. **API Structure**:
```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/settings
PUT    /api/settings
GET    /api/wallet/balance
POST   /api/wallet/send
GET    /api/delegators
PUT    /api/delegators/:address/fee
GET    /api/payments
GET    /api/payments/:cycle
POST   /api/batch/upload
POST   /api/batch/execute
GET    /api/bondpool
POST   /api/bondpool/members
GET    /api/status
PUT    /api/status/mode
```

3. **Real-time Updates**:
   - WebSockets for balance updates
   - Server-Sent Events for payment status

4. **Background Jobs**:
   - Use Bull/Agenda for scheduled blockchain polling
   - Separate worker process for payment distribution

---

*This document maps all HTTP endpoints in TAPS. See BUSINESS_LOGIC.md for detailed processing logic.*
