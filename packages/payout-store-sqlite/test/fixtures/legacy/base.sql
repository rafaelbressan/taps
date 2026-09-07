-- DDL copiada literalmente de components/environment.cfc do TAPS em CFML
-- (commit 6b598e78, o último antes da remoção do ColdFusion).
CREATE TABLE settings
(
   baker_id          VARCHAR(50) NOT NULL,
   default_fee       DECIMAL(6,2) NOT NULL,
   update_freq       INTEGER NOT NULL,
   user_name         VARCHAR(100),
   pass_hash         VARCHAR(150),
   application_port  INTEGER NOT NULL,
   client_path       VARCHAR(200) NOT NULL,
   node_alias        VARCHAR(100) NOT NULL,
   status            BOOLEAN,
   mode              VARCHAR(20),
   hash_salt         VARCHAR(150),
   base_dir          VARCHAR(200) NOT NULL,
   wallet_hash       VARCHAR(150),
   wallet_salt       VARCHAR(150),
   phrase            VARCHAR(150),
   app_phrase        VARCHAR(150),
   funds_origin      VARCHAR(20)
);
ALTER TABLE settings ADD PRIMARY KEY (baker_id);

CREATE TABLE payments
(
   baker_id VARCHAR(50) NOT NULL,
   cycle    INTEGER NOT NULL,
   date     DATE,
   result   VARCHAR(20) NOT NULL,
   total    DECIMAL(20,2) NOT NULL
);
ALTER TABLE payments ADD PRIMARY KEY (baker_id, cycle, date, result);

CREATE TABLE delegatorsPayments
(
   baker_id VARCHAR(50) NOT NULL,
   cycle    INTEGER NOT NULL,
   address  VARCHAR(50) NOT NULL,
   date     DATE,
   result   VARCHAR(20) NOT NULL,
   total    DECIMAL(20,2) NOT NULL
);
ALTER TABLE delegatorsPayments ADD PRIMARY KEY (baker_id, cycle, address, date, result);

CREATE TABLE delegatorsFee
(
   baker_id VARCHAR(50)  NOT NULL,
   address  VARCHAR(50)  NOT NULL,
   fee      DECIMAL(6,2) NOT NULL
);
ALTER TABLE delegatorsFee ADD PRIMARY KEY (baker_id, address);

CREATE TABLE bondPoolSettings
(
   baker_id    VARCHAR(50)  NOT NULL,
   status      BOOLEAN      NOT NULL
);
ALTER TABLE bondPoolSettings ADD PRIMARY KEY (baker_id);

CREATE TABLE bondPool
(
   baker_id    VARCHAR(50)  NOT NULL,
   address     VARCHAR(50)  NOT NULL,
   amount      DECIMAL(20,2) NOT NULL,
   name        VARCHAR(50),
   adm_charge  DECIMAL(20,2) NOT NULL,
   is_manager  BOOLEAN
);
ALTER TABLE bondPool ADD PRIMARY KEY (baker_id, address);
