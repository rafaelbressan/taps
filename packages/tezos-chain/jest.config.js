module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
};
