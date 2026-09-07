-- checkSixDecimals() e addTxHashFields(), de components/database.cfc.
-- Uma instalação que nunca rodou uma versão nova do TAPS NÃO tem isto.
ALTER TABLE payments ALTER COLUMN total DECIMAL(20,6) NOT NULL;
ALTER TABLE delegatorsPayments ALTER COLUMN total DECIMAL(20,6) NOT NULL;
ALTER TABLE payments ADD COLUMN TRANSACTION_HASH VARCHAR(70) NULL;
ALTER TABLE delegatorsPayments ADD COLUMN TRANSACTION_HASH VARCHAR(70) NULL;
