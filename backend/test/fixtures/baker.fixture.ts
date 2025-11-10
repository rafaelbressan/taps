/**
 * Test Baker Fixture
 *
 * Sample baker data for testing
 */

export const testBaker = {
  bakerId: 'tz1TestBaker123456789',
  userName: 'testbaker',
  passHash: '$2b$12$testhashedpassword',
  hashSalt: null,
  defaultFee: 5.0,
  mode: 'simulation',
  admCharge: 10.0,
  minPayment: 0.0,
  overDel: false,
  paymentRetries: 3,
  minutesBetweenRetries: 5,
  updateFreq: 10,
  numBlocksWait: 2,
  email: 'test@example.com',
  phrase: 'encrypted_mnemonic',
  appPhrase: 'encrypted_app_mnemonic',
  walletHash: 'test_wallet_hash',
  walletSalt: 'test_wallet_salt',
  notificationSettings: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

export const testBakerWithWallet = {
  ...testBaker,
  phrase: 'test_encrypted_phrase',
  appPhrase: 'test_encrypted_app_phrase',
  walletHash: 'test_hash',
  walletSalt: 'test_salt',
};

export const testBakerWithoutWallet = {
  ...testBaker,
  phrase: null,
  appPhrase: null,
  walletHash: null,
  walletSalt: null,
};
