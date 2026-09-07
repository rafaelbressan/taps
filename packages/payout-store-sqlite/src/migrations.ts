/**
 * The schema, as an ordered list of migrations.
 *
 * `prisma/migrations/` in the version this replaces contains one `.gitkeep`
 * and nothing else: `prisma migrate deploy` succeeds and creates no table.
 * That is the defect this file exists to close, so the rules are strict.
 *
 * - A migration is **append-only**. Once a version has shipped it is never
 *   edited, because the only thing that makes a migration list trustworthy is
 *   that the same version means the same SQL on every machine.
 * - Migrations are **embedded in the code**, not read from disk. The desktop
 *   app runs this from a webview that has no filesystem, and a schema that
 *   depends on files being installed next to the binary is a schema that is
 *   missing on the one machine that matters.
 * - Every money column is `INTEGER` with `CHECK (x >= 0)`. SQLite integers are
 *   64-bit; the whole XTZ supply is under 10^15 mutez, so the type is exact
 *   over the entire domain and there is no place for a float to appear.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Statements, run in order, all inside one transaction. */
  readonly sql: string;
}

const INIT = `
CREATE TABLE distributions (
  baker_id                     TEXT    NOT NULL,
  cycle                        INTEGER NOT NULL,
  status                       TEXT    NOT NULL
    CHECK (status IN ('planned','sending','settled','failed','blocked')),
  network                      TEXT    NOT NULL,
  protocol_hash                TEXT    NOT NULL,
  pool                         INTEGER NOT NULL CHECK (pool >= 0),
  own_share                    INTEGER NOT NULL CHECK (own_share >= 0),
  baker_fee                    INTEGER NOT NULL CHECK (baker_fee >= 0),
  distributable                INTEGER NOT NULL CHECK (distributable >= 0),
  remainder                    INTEGER NOT NULL CHECK (remainder >= 0),
  total_to_send                INTEGER NOT NULL CHECK (total_to_send >= 0),
  fee_numerator                INTEGER NOT NULL CHECK (fee_numerator >= 0),
  fee_denominator              INTEGER NOT NULL CHECK (fee_denominator > 0),
  block_fees_included          INTEGER NOT NULL CHECK (block_fees_included IN (0,1)),
  payout_factor_numerator      INTEGER NOT NULL CHECK (payout_factor_numerator >= 0),
  payout_factor_denominator    INTEGER NOT NULL CHECK (payout_factor_denominator > 0),
  delegator_count              INTEGER NOT NULL CHECK (delegator_count >= 0),
  created_at                   TEXT    NOT NULL,
  updated_at                   TEXT    NOT NULL,
  PRIMARY KEY (baker_id, cycle)
);

CREATE TABLE delegator_lines (
  baker_id                TEXT    NOT NULL,
  cycle                   INTEGER NOT NULL,
  address                 TEXT    NOT NULL,
  delegated_balance       INTEGER NOT NULL CHECK (delegated_balance >= 0),
  gross                   INTEGER NOT NULL CHECK (gross >= 0),
  commission              INTEGER NOT NULL CHECK (commission >= 0),
  net                     INTEGER NOT NULL CHECK (net >= 0),
  carried_in              INTEGER NOT NULL CHECK (carried_in >= 0),
  payable                 INTEGER NOT NULL CHECK (payable >= 0),
  transfer_cost           INTEGER NOT NULL CHECK (transfer_cost >= 0),
  minimum                 INTEGER NOT NULL CHECK (minimum >= 0),
  withheld                INTEGER NOT NULL CHECK (withheld >= 0),
  amount                  INTEGER NOT NULL CHECK (amount >= 0),
  carried_out             INTEGER NOT NULL CHECK (carried_out >= 0),
  emptied                 INTEGER NOT NULL CHECK (emptied IN (0,1)),
  batch_index             INTEGER,
  op_hash                 TEXT,
  result                  TEXT    NOT NULL
    CHECK (result IN ('planned','applied','deferred','failed')),
  PRIMARY KEY (baker_id, cycle, address),
  -- RESTRICT, deliberately. The schema being replaced had
  -- \`onDelete: Cascade\` from settings, so removing a configuration row took
  -- the whole financial history with it.
  FOREIGN KEY (baker_id, cycle) REFERENCES distributions (baker_id, cycle)
    ON DELETE RESTRICT
);

CREATE TABLE batches (
  baker_id        TEXT    NOT NULL,
  cycle           INTEGER NOT NULL,
  batch_index     INTEGER NOT NULL CHECK (batch_index >= 0),
  status          TEXT    NOT NULL
    CHECK (status IN ('pending','injected','included','confirmed','failed','expired')),
  op_hash         TEXT,
  counter         TEXT,
  branch          TEXT,
  branch_level    INTEGER,
  total_amount    INTEGER NOT NULL CHECK (total_amount >= 0),
  total_fees      INTEGER NOT NULL CHECK (total_fees >= 0),
  total_burn      INTEGER NOT NULL CHECK (total_burn >= 0),
  total_gas       INTEGER NOT NULL CHECK (total_gas >= 0),
  total_storage   INTEGER NOT NULL CHECK (total_storage >= 0),
  injected_at     TEXT,
  included_level  INTEGER,
  confirmed_at    TEXT,
  error           TEXT,
  PRIMARY KEY (baker_id, cycle, batch_index),
  FOREIGN KEY (baker_id, cycle) REFERENCES distributions (baker_id, cycle)
    ON DELETE RESTRICT
);

CREATE TABLE batch_transfers (
  baker_id       TEXT    NOT NULL,
  cycle          INTEGER NOT NULL,
  batch_index    INTEGER NOT NULL,
  position       INTEGER NOT NULL CHECK (position >= 0),
  address        TEXT    NOT NULL,
  amount         INTEGER NOT NULL CHECK (amount >= 0),
  fee            INTEGER NOT NULL CHECK (fee >= 0),
  gas_limit      INTEGER NOT NULL CHECK (gas_limit >= 0),
  storage_limit  INTEGER NOT NULL CHECK (storage_limit >= 0),
  burn           INTEGER NOT NULL CHECK (burn >= 0),
  PRIMARY KEY (baker_id, cycle, batch_index, position),
  FOREIGN KEY (baker_id, cycle, batch_index)
    REFERENCES batches (baker_id, cycle, batch_index) ON DELETE RESTRICT
);

-- Append-only. A superseded attempt is the record that money may already have
-- moved; the version being replaced deleted it before resending.
CREATE TABLE batch_attempts (
  baker_id      TEXT    NOT NULL,
  cycle         INTEGER NOT NULL,
  batch_index   INTEGER NOT NULL,
  seq           INTEGER NOT NULL CHECK (seq >= 0),
  op_hash       TEXT    NOT NULL,
  counter       TEXT    NOT NULL,
  branch        TEXT    NOT NULL,
  branch_level  INTEGER NOT NULL,
  at            TEXT    NOT NULL,
  PRIMARY KEY (baker_id, cycle, batch_index, seq),
  FOREIGN KEY (baker_id, cycle, batch_index)
    REFERENCES batches (baker_id, cycle, batch_index) ON DELETE RESTRICT
);

CREATE TABLE carry_over (
  baker_id  TEXT    NOT NULL,
  address   TEXT    NOT NULL,
  balance   INTEGER NOT NULL CHECK (balance > 0),
  PRIMARY KEY (baker_id, address)
);

CREATE TABLE debt_settlements (
  baker_id        TEXT    NOT NULL,
  settlement_id   TEXT    NOT NULL,
  status          TEXT    NOT NULL
    CHECK (status IN ('planned','sending','settled','failed','blocked')),
  network         TEXT    NOT NULL,
  protocol_hash   TEXT    NOT NULL,
  actor           TEXT    NOT NULL,
  reason          TEXT    NOT NULL,
  total_amount    INTEGER NOT NULL CHECK (total_amount >= 0),
  total_fees      INTEGER NOT NULL CHECK (total_fees >= 0),
  total_burn      INTEGER NOT NULL CHECK (total_burn >= 0),
  op_hash         TEXT,
  counter         TEXT,
  branch          TEXT,
  branch_level    INTEGER,
  injected_at     TEXT,
  included_level  INTEGER,
  confirmed_at    TEXT,
  error           TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  PRIMARY KEY (baker_id, settlement_id)
);

CREATE TABLE debt_settlement_lines (
  baker_id       TEXT    NOT NULL,
  settlement_id  TEXT    NOT NULL,
  position       INTEGER NOT NULL CHECK (position >= 0),
  address        TEXT    NOT NULL,
  amount         INTEGER NOT NULL CHECK (amount >= 0),
  fee            INTEGER NOT NULL CHECK (fee >= 0),
  gas_limit      INTEGER NOT NULL CHECK (gas_limit >= 0),
  storage_limit  INTEGER NOT NULL CHECK (storage_limit >= 0),
  burn           INTEGER NOT NULL CHECK (burn >= 0),
  PRIMARY KEY (baker_id, settlement_id, position),
  FOREIGN KEY (baker_id, settlement_id)
    REFERENCES debt_settlements (baker_id, settlement_id) ON DELETE RESTRICT
);

CREATE TABLE settlement_attempts (
  baker_id       TEXT    NOT NULL,
  settlement_id  TEXT    NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq >= 0),
  op_hash        TEXT    NOT NULL,
  counter        TEXT    NOT NULL,
  branch         TEXT    NOT NULL,
  branch_level   INTEGER NOT NULL,
  at             TEXT    NOT NULL,
  PRIMARY KEY (baker_id, settlement_id, seq),
  FOREIGN KEY (baker_id, settlement_id)
    REFERENCES debt_settlements (baker_id, settlement_id) ON DELETE RESTRICT
);

-- One row per operation hash EVER recorded, across cycles and settlements
-- alike. The primary key is what makes "the same operation cannot belong to
-- two distributions" a database fact rather than an engine habit.
CREATE TABLE operation_hashes (
  op_hash  TEXT NOT NULL PRIMARY KEY,
  owner    TEXT NOT NULL
);

CREATE TABLE audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT    NOT NULL,
  baker_id      TEXT    NOT NULL,
  cycle         INTEGER,
  actor         TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('ok','refused','error')),
  params        TEXT    NOT NULL,
  op_hash       TEXT,
  destinations  TEXT,
  amount        INTEGER,
  detail        TEXT
);

CREATE INDEX audit_by_baker_cycle ON audit (baker_id, cycle, id);
CREATE INDEX batches_by_hash ON batches (op_hash);
`;

const LEGACY_HISTORY = `
-- The payment history of the version being replaced, imported verbatim.
--
-- It is kept in its own tables and never merged into \`distributions\`: the old
-- system stored XTZ with six decimals as a DECIMAL, has no batch, no operation
-- attempt and no carry-over, and inventing those fields to make the rows fit
-- the new shape would be fabricating an audit trail. What it does have — who
-- was paid, how much, in which cycle, under which hash — is preserved exactly,
-- and the amounts are converted to mutez on the way in.
CREATE TABLE legacy_import (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at    TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  source_sha256  TEXT    NOT NULL,
  cycles         INTEGER NOT NULL CHECK (cycles >= 0),
  payments       INTEGER NOT NULL CHECK (payments >= 0),
  delegator_rows INTEGER NOT NULL CHECK (delegator_rows >= 0),
  total_paid     INTEGER NOT NULL CHECK (total_paid >= 0)
);

CREATE TABLE legacy_payments (
  baker_id          TEXT    NOT NULL,
  cycle             INTEGER NOT NULL,
  paid_on           TEXT,
  result            TEXT    NOT NULL,
  total             INTEGER NOT NULL CHECK (total >= 0),
  transaction_hash  TEXT,
  PRIMARY KEY (baker_id, cycle, paid_on, result)
);

CREATE TABLE legacy_delegator_payments (
  baker_id          TEXT    NOT NULL,
  cycle             INTEGER NOT NULL,
  address           TEXT    NOT NULL,
  paid_on           TEXT,
  result            TEXT    NOT NULL,
  total             INTEGER NOT NULL CHECK (total >= 0),
  transaction_hash  TEXT,
  PRIMARY KEY (baker_id, cycle, address, paid_on, result)
);

CREATE INDEX legacy_delegator_payments_by_address
  ON legacy_delegator_payments (baker_id, address, cycle);

-- Configuration the baker will not want to retype. Fee is kept as the exact
-- rational the old DECIMAL(6,2) held: 5.25% becomes 525/10000, never 0.0525.
CREATE TABLE legacy_delegator_fees (
  baker_id        TEXT    NOT NULL,
  address         TEXT    NOT NULL,
  fee_numerator   INTEGER NOT NULL CHECK (fee_numerator >= 0),
  fee_denominator INTEGER NOT NULL CHECK (fee_denominator > 0),
  PRIMARY KEY (baker_id, address)
);

CREATE TABLE legacy_bond_pool (
  baker_id    TEXT    NOT NULL,
  address     TEXT    NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  name        TEXT,
  adm_numerator   INTEGER NOT NULL CHECK (adm_numerator >= 0),
  adm_denominator INTEGER NOT NULL CHECK (adm_denominator > 0),
  is_manager  INTEGER NOT NULL CHECK (is_manager IN (0,1)),
  PRIMARY KEY (baker_id, address)
);
`;

/**
 * Local operator configuration.
 *
 * There is no user, no password and no session table, and that is the point:
 * the desktop app has no HTTP surface, so it has nobody to authenticate. What
 * it does need to remember is where the signer is and which policy the baker
 * chose — and the signer's client credential is NOT here. It lives in the
 * vault, and the column that would hold it does not exist so that it cannot
 * be written by accident.
 */
const OPERATOR_SETTINGS = `
CREATE TABLE app_settings (
  key    TEXT NOT NULL PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'payout state', sql: INIT },
  { version: 2, name: 'legacy history', sql: LEGACY_HISTORY },
  { version: 3, name: 'operator settings', sql: OPERATOR_SETTINGS },
]);
