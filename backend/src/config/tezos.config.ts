import { z } from 'zod';

/**
 * Tezos network types
 */
export enum TezosNetwork {
  MAINNET = 'mainnet',
  GHOSTNET = 'ghostnet',
  CUSTOM = 'custom',
}

/**
 * Network-specific RPC endpoints and explorers
 */
export const NETWORK_CONFIG = {
  [TezosNetwork.MAINNET]: {
    rpcUrl: 'https://mainnet.api.tez.ie',
    fallbackRpcUrls: [
      'https://rpc.tzbeta.net',
      'https://mainnet.smartpy.io',
    ],
    tzktApiUrl: 'https://api.tzkt.io',
    blockExplorer: 'https://tzkt.io',
    networkId: 'NetXdQprcVkpaWU',
  },
  [TezosNetwork.GHOSTNET]: {
    rpcUrl: 'https://rpc.ghostnet.teztnets.xyz',
    fallbackRpcUrls: [
      'https://ghostnet.ecadinfra.com',
      'https://ghostnet.smartpy.io',
    ],
    tzktApiUrl: 'https://api.ghostnet.tzkt.io',
    blockExplorer: 'https://ghostnet.tzkt.io',
    networkId: 'NetXnHfVqm9iesp',
  },
} as const;

/**
 * Tezos blockchain constants
 */
export const TEZOS_CONSTANTS = {
  // Conversion factor
  MUTEZ_PER_TEZ: 1_000_000,

  // Transaction hash validation
  TX_HASH_MIN_LENGTH: 46,
  TX_HASH_MAX_LENGTH: 60,

  // Address validation patterns
  ADDRESS_PATTERNS: {
    TZ1: /^tz1[1-9A-HJ-NP-Za-km-z]{33}$/,
    TZ2: /^tz2[1-9A-HJ-NP-Za-km-z]{33}$/,
    TZ3: /^tz3[1-9A-HJ-NP-Za-km-z]{33}$/,
    KT1: /^KT1[1-9A-HJ-NP-Za-km-z]{33}$/,
  },

  // Default gas and storage limits (from DATABASE_SCHEMA.md)
  DEFAULT_GAS_LIMIT: 15400,
  DEFAULT_STORAGE_LIMIT: 300,
  DEFAULT_TRANSACTION_FEE: 0.0018, // in tez

  // Confirmation blocks
  DEFAULT_CONFIRMATION_BLOCKS: 8,

  // Cycle duration (on mainnet: 4096 blocks, ~2.8 days)
  BLOCKS_PER_CYCLE: 4096,

  // Cycles until rewards are delivered (from BUSINESS_LOGIC.md)
  CYCLES_UNTIL_DELIVERED: 5,

  // RPC retry configuration
  RPC_RETRY_ATTEMPTS: 3,
  RPC_RETRY_DELAY_MS: 1000,
  RPC_TIMEOUT_MS: 30000,

  // Batch transaction limits
  MAX_BATCH_SIZE: 100,
  MAX_BATCH_OPERATIONS: 200,
} as const;

/**
 * Tezos configuration schema
 */
export const TezosConfigSchema = z.object({
  network: z.nativeEnum(TezosNetwork),
  rpcUrl: z.string().url(),
  fallbackRpcUrls: z.array(z.string().url()).optional(),
  tzktApiUrl: z.string().url(),
  blockExplorer: z.string().url(),
  gasLimit: z.number().int().min(0).default(TEZOS_CONSTANTS.DEFAULT_GAS_LIMIT),
  storageLimit: z.number().int().min(0).default(TEZOS_CONSTANTS.DEFAULT_STORAGE_LIMIT),
  transactionFee: z.number().min(0).default(TEZOS_CONSTANTS.DEFAULT_TRANSACTION_FEE),
  confirmationBlocks: z.number().int().min(1).default(TEZOS_CONSTANTS.DEFAULT_CONFIRMATION_BLOCKS),
  retryAttempts: z.number().int().min(1).default(TEZOS_CONSTANTS.RPC_RETRY_ATTEMPTS),
  retryDelayMs: z.number().int().min(100).default(TEZOS_CONSTANTS.RPC_RETRY_DELAY_MS),
  timeoutMs: z.number().int().min(1000).default(TEZOS_CONSTANTS.RPC_TIMEOUT_MS),
});

export type TezosConfig = z.infer<typeof TezosConfigSchema>;

/**
 * Get Tezos configuration from environment
 */
export function getTezosConfig(): TezosConfig {
  const network = (process.env.TEZOS_NETWORK as TezosNetwork) || TezosNetwork.GHOSTNET;
  const networkConfig = NETWORK_CONFIG[network];

  if (!networkConfig) {
    throw new Error(`Unknown Tezos network: ${network}`);
  }

  const config: TezosConfig = {
    network,
    rpcUrl: process.env.TEZOS_RPC_URL || networkConfig.rpcUrl,
    fallbackRpcUrls: networkConfig.fallbackRpcUrls,
    tzktApiUrl: process.env.TZKT_API_URL || networkConfig.tzktApiUrl,
    blockExplorer: process.env.BLOCK_EXPLORER || networkConfig.blockExplorer,
    gasLimit: parseInt(process.env.GAS_LIMIT || String(TEZOS_CONSTANTS.DEFAULT_GAS_LIMIT)),
    storageLimit: parseInt(process.env.STORAGE_LIMIT || String(TEZOS_CONSTANTS.DEFAULT_STORAGE_LIMIT)),
    transactionFee: parseFloat(process.env.DEFAULT_TRANSACTION_FEE || String(TEZOS_CONSTANTS.DEFAULT_TRANSACTION_FEE)),
    confirmationBlocks: parseInt(process.env.NUM_BLOCKS_WAIT || String(TEZOS_CONSTANTS.DEFAULT_CONFIRMATION_BLOCKS)),
    retryAttempts: TEZOS_CONSTANTS.RPC_RETRY_ATTEMPTS,
    retryDelayMs: TEZOS_CONSTANTS.RPC_RETRY_DELAY_MS,
    timeoutMs: TEZOS_CONSTANTS.RPC_TIMEOUT_MS,
  };

  return TezosConfigSchema.parse(config);
}

/**
 * Validate Tezos address format
 */
export function isValidTezosAddress(address: string): boolean {
  return Object.values(TEZOS_CONSTANTS.ADDRESS_PATTERNS).some(pattern =>
    pattern.test(address)
  );
}

/**
 * Get address type
 */
export function getAddressType(address: string): 'tz1' | 'tz2' | 'tz3' | 'KT1' | null {
  if (TEZOS_CONSTANTS.ADDRESS_PATTERNS.TZ1.test(address)) return 'tz1';
  if (TEZOS_CONSTANTS.ADDRESS_PATTERNS.TZ2.test(address)) return 'tz2';
  if (TEZOS_CONSTANTS.ADDRESS_PATTERNS.TZ3.test(address)) return 'tz3';
  if (TEZOS_CONSTANTS.ADDRESS_PATTERNS.KT1.test(address)) return 'KT1';
  return null;
}

/**
 * Validate transaction hash format
 */
export function isValidTransactionHash(hash: string): boolean {
  return (
    hash.length >= TEZOS_CONSTANTS.TX_HASH_MIN_LENGTH &&
    hash.length <= TEZOS_CONSTANTS.TX_HASH_MAX_LENGTH &&
    /^o[1-9A-HJ-NP-Za-km-z]+$/.test(hash)
  );
}

/**
 * Convert mutez to tez
 */
export function mutezToTez(mutez: number): number {
  return mutez / TEZOS_CONSTANTS.MUTEZ_PER_TEZ;
}

/**
 * Convert tez to mutez
 */
export function tezToMutez(tez: number): number {
  return Math.floor(tez * TEZOS_CONSTANTS.MUTEZ_PER_TEZ);
}
