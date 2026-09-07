module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
  moduleNameMapper: {
    '^@tezos-suite/chain$': '<rootDir>/../tezos-chain/src/index.ts',
    '^@tezos-suite/payout$': '<rootDir>/../payout-engine/src/index.ts',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  testTimeout: 60000,
};
