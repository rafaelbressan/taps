import { z } from 'zod';

// Zod schema for environment variable validation
const configSchema = z.object({
  // Application
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(3000),

  // Database
  databaseUrl: z.string().url(),

  // JWT
  jwtSecret: z.string().min(32),
  jwtExpiration: z.string().default('7d'),

  // Encryption
  encryptionSecret: z.string().min(32),

  // Tezos
  tezosNetwork: z.enum(['mainnet', 'ghostnet']).default('ghostnet'),
  tezosRpcUrl: z.string().url(),

  // Tezos Transaction Settings
  gasLimit: z.coerce.number().default(15400),
  storageLimit: z.coerce.number().default(300),
  defaultTransactionFee: z.string().default('0.001800'),

  // Tezos Blockchain Settings
  blocksPerCycle: z.coerce.number().default(4096),
  preservedCycles: z.coerce.number().default(5),
  numBlocksToWait: z.coerce.number().default(8),

  // Payment Configuration
  paymentRetries: z.coerce.number().default(1),
  minutesBetweenRetries: z.coerce.number().default(1),

  // Block Explorer
  blockExplorerUrl: z.string().url(),
  blockExplorerTxUrl: z.string().url(),

  // TzKT API
  tzktApiUrl: z.string().url(),

  // Proxy (optional)
  proxyServer: z.string().optional().default(''),
  proxyPort: z.coerce.number().optional().default(80),

  // Redis
  redisHost: z.string().default('localhost'),
  redisPort: z.coerce.number().default(6379),

  // Rate Limiting
  throttleTtl: z.coerce.number().default(60),
  throttleLimit: z.coerce.number().default(10),

  // Logging
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Default Application Settings
  defaultFee: z.coerce.number().default(5.0),
  defaultUpdateFreq: z.coerce.number().default(10),
});

export type Config = z.infer<typeof configSchema>;

export function validateConfig() {
  const config = {
    // Application
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,

    // Database
    databaseUrl: process.env.DATABASE_URL,

    // JWT
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiration: process.env.JWT_EXPIRATION,

    // Encryption
    encryptionSecret: process.env.ENCRYPTION_SECRET,

    // Tezos
    tezosNetwork: process.env.TEZOS_NETWORK,
    tezosRpcUrl: process.env.TEZOS_RPC_URL,

    // Tezos Transaction Settings
    gasLimit: process.env.GAS_LIMIT,
    storageLimit: process.env.STORAGE_LIMIT,
    defaultTransactionFee: process.env.DEFAULT_TRANSACTION_FEE,

    // Tezos Blockchain Settings
    blocksPerCycle: process.env.BLOCKS_PER_CYCLE,
    preservedCycles: process.env.PRESERVED_CYCLES,
    numBlocksToWait: process.env.NUM_BLOCKS_TO_WAIT,

    // Payment Configuration
    paymentRetries: process.env.PAYMENT_RETRIES,
    minutesBetweenRetries: process.env.MINUTES_BETWEEN_RETRIES,

    // Block Explorer
    blockExplorerUrl: process.env.BLOCK_EXPLORER_URL,
    blockExplorerTxUrl: process.env.BLOCK_EXPLORER_TX_URL,

    // TzKT API
    tzktApiUrl: process.env.TZKT_API_URL,

    // Proxy
    proxyServer: process.env.PROXY_SERVER,
    proxyPort: process.env.PROXY_PORT,

    // Redis
    redisHost: process.env.REDIS_HOST,
    redisPort: process.env.REDIS_PORT,

    // Rate Limiting
    throttleTtl: process.env.THROTTLE_TTL,
    throttleLimit: process.env.THROTTLE_LIMIT,

    // Logging
    logLevel: process.env.LOG_LEVEL,

    // Default Application Settings
    defaultFee: process.env.DEFAULT_FEE,
    defaultUpdateFreq: process.env.DEFAULT_UPDATE_FREQ,
  };

  try {
    return configSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map((err) => `${err.path.join('.')}: ${err.message}`).join('\n');
      throw new Error(`Configuration validation failed:\n${errors}`);
    }
    throw error;
  }
}

export default () => validateConfig();
