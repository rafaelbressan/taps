import { ConfigurationError } from './errors';

/**
 * A network is endpoints and nothing else. No protocol constant is named
 * here: `blocks_per_cycle` is 14400 on mainnet and Shadownet but 3600 on
 * Bakingnet, so a value written next to the URL would be wrong by 4x on the
 * TAPS testnet — silently, because nothing in a response contradicts it.
 *
 * There are no built-in networks either. `ghostnet` is absent from
 * teztnets.json; a default list is how a dead network survives in code.
 */
export interface NetworkConfig {
  /** Free-form label used in logs and errors, e.g. "mainnet", "bakingnet". */
  readonly name: string;
  /** Octez RPC. Source of truth for protocol constants. */
  readonly rpcUrl: string;
  /** TzKT indexer base URL. Source of reward splits and operation status. */
  readonly tzktApiUrl: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() === '') {
    throw new ConfigurationError(
      `${key} is not set — network endpoints are configuration, never code`,
    );
  }
  return value.trim();
}

function requireUrl(value: string, key: string): string {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    throw new ConfigurationError(`${key} is not a URL: ${JSON.stringify(value)}`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Reads TEZOS_NETWORK, TEZOS_RPC_URL and TZKT_API_URL. All three are
 * required: a missing endpoint must stop the process, not fall back to
 * somebody else's chain.
 */
export function loadNetworkFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  return {
    name: requireEnv(env, 'TEZOS_NETWORK'),
    rpcUrl: requireUrl(requireEnv(env, 'TEZOS_RPC_URL'), 'TEZOS_RPC_URL'),
    tzktApiUrl: requireUrl(requireEnv(env, 'TZKT_API_URL'), 'TZKT_API_URL'),
  };
}

export function defineNetwork(config: NetworkConfig): NetworkConfig {
  return {
    name: config.name,
    rpcUrl: requireUrl(config.rpcUrl, 'rpcUrl'),
    tzktApiUrl: requireUrl(config.tzktApiUrl, 'tzktApiUrl'),
  };
}
