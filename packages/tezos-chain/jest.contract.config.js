// Contract tests hit the real TzKT API. They are intentionally NOT part of
// `npm test`: a network failure must not be reported as a code failure.
// Run them on a schedule and before every release — they are the only check
// that fails when TzKT removes a field the payout math depends on.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/contract/**/*.spec.ts'],
  testTimeout: 120000,
};
