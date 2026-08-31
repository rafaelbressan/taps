import { parseProtocolConstants, type ProtocolConstants } from '@tezos-suite/chain';

/**
 * Constants for tests, built through the SAME parser the runtime uses, from a
 * raw payload shaped like `/chains/main/blocks/head/context/constants`.
 *
 * Values here are test inputs, not knowledge about any network: every test
 * that depends on one varies it, which is the point — a client that reads the
 * constants survives them changing, and these tests fail if it stops.
 */
export function testConstants(
  overrides: Record<string, unknown> = {},
  protocolHash = 'PsTestProtocolHashForUnitTestsOnly000000000000',
): ProtocolConstants {
  return parseProtocolConstants(
    {
      blocks_per_cycle: 2048,
      minimal_block_delay: 8,
      delay_increment_per_round: 4,
      consensus_rights_delay: 2,
      blocks_preservation_cycles: 1,
      consensus_committee_size: 1234,
      consensus_threshold_size: 823,
      hard_gas_limit_per_operation: 900_000,
      hard_gas_limit_per_block: 900_000,
      hard_storage_limit_per_operation: 60_000,
      max_operation_data_length: 20_000,
      max_operations_time_to_live: 600,
      cost_per_byte: 250,
      origination_size: 257,
      edge_of_staking_over_delegation: 3,
      minimal_stake: 5_000_000_000,
      denunciation_period: 1,
      slashing_delay: 1,
      ...overrides,
    },
    'NetXTestChainId',
    protocolHash,
  );
}
