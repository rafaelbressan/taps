import { defineNetwork, type NetworkConfig } from '../../src/network';

/** Endpoints for the fake transport. Never contacted in unit tests. */
export const TEST_NETWORK: NetworkConfig = defineNetwork({
  name: 'test',
  rpcUrl: 'https://rpc.invalid',
  tzktApiUrl: 'https://tzkt.invalid',
});
