-- Linhas escritas com a MESMA lista de colunas que o TAPS em CFML usa:
--   settings            -> database.cfc:101
--   payments            -> database.cfc:217  (BAKER_ID, CYCLE, DATE, RESULT, TOTAL)
--   delegatorsPayments  -> taps.cfc:216      (+ TRANSACTION_HASH)
--   delegatorsFee       -> database.cfc:174
--   bondPool            -> database.cfc:629
INSERT INTO settings (baker_id, default_fee, update_freq, user_name, pass_hash, application_port, client_path, node_alias, status, mode, hash_salt, base_dir, wallet_hash, wallet_salt, phrase, app_phrase, funds_origin)
VALUES ('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 5.25, 10, 'admin', 'A3F5C9D1E7B2', 8888, '/usr/local/bin', 'node_alias', TRUE, 'on', 'S4LT', '/opt/lucee/tomcat/webapps/taps', 'W4LLETH4SH', 'W4LLETS4LT', 'U2FsdGVkX1+segredo', 'U2FsdGVkX1+appsegredo', 'native');

INSERT INTO payments (BAKER_ID, CYCLE, DATE, RESULT, TOTAL, TRANSACTION_HASH) VALUES
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 499, parsedatetime('01-15-2024','MM-dd-yyyy'), 'paid', 125.543210, 'onvX8vBGFcJtwvpFHnyMhoZnCVCbSPTUPYPTHmzXHTHqfjqqLhx'),
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 500, parsedatetime('01-18-2024','MM-dd-yyyy'), 'rewards_pending', 0.000000, NULL);

INSERT INTO delegatorsPayments (BAKER_ID, CYCLE, ADDRESS, DATE, RESULT, TOTAL, TRANSACTION_HASH) VALUES
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 499, 'tz1RLNfVUUvzCcAkTHsFrEZH1Kg7cCbNNy4M', parsedatetime('01-15-2024','MM-dd-yyyy'), 'applied', 120.000000, 'onvX8vBGFcJtwvpFHnyMhoZnCVCbSPTUPYPTHmzXHTHqfjqqLhx'),
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 499, 'tz1burnburnburnburnburnburnburjAYjjX', parsedatetime('01-15-2024','MM-dd-yyyy'), 'applied', 0.003970, 'onvX8vBGFcJtwvpFHnyMhoZnCVCbSPTUPYPTHmzXHTHqfjqqLhx'),
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 499, 'tz1gjaF81ZRRvdzjobyfVNsAeSC6PScjfQwN', parsedatetime('01-15-2024','MM-dd-yyyy'), 'failed', 5.539240, NULL);

INSERT INTO delegatorsFee (BAKER_ID, ADDRESS, FEE) VALUES
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 'tz1RLNfVUUvzCcAkTHsFrEZH1Kg7cCbNNy4M', 5.25),
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 'tz1gjaF81ZRRvdzjobyfVNsAeSC6PScjfQwN', 0.00);

INSERT INTO bondPool (BAKER_ID, ADDRESS, AMOUNT, NAME, ADM_CHARGE, IS_MANAGER) VALUES
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 'tz1RLNfVUUvzCcAkTHsFrEZH1Kg7cCbNNy4M', 5000.00, 'O''Brien', 2.00, TRUE),
('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', 'tz1gjaF81ZRRvdzjobyfVNsAeSC6PScjfQwN', 3000.00, NULL, 2.00, FALSE);

INSERT INTO bondPoolSettings (baker_id, status) VALUES ('tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', TRUE);
