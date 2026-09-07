/**
 * Integration tests that need a real `octez-signer`. Kept out of `npm test`
 * so a host without docker fails at the gate it can actually satisfy.
 *
 *   npm run test:signer
 */
module.exports = {
  ...require('./jest.config.js'),
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  testTimeout: 300000,
};
