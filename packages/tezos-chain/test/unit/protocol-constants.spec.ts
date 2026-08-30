import { FieldTypeError, MissingFieldError } from '../../src/errors';
import {
  ProtocolConstantsProvider,
  REMOVED_CONSTANT_FIELDS,
  cycleDurationSeconds,
  parseProtocolConstants,
} from '../../src/rpc/protocol-constants';
import type { RpcSource } from '../../src/rpc/rpc-source';

/**
 * Read from https://rpc.tzbeta.net/chains/main/blocks/head/context/constants
 * on 2026-08-30. Kept as a fixture, never imported by src/.
 */
const MAINNET_RAW: Record<string, unknown> = {
  blocks_per_cycle: 14400,
  minimal_block_delay: 6,
  delay_increment_per_round: 3,
  consensus_rights_delay: 2,
  blocks_preservation_cycles: 1,
  consensus_committee_size: 7000,
  consensus_threshold_size: 4667,
  hard_gas_limit_per_operation: 1040000,
  hard_gas_limit_per_block: 1040000,
  hard_storage_limit_per_operation: 60000,
  max_operation_data_length: 32768,
  max_operations_time_to_live: 600,
  cost_per_byte: 250,
  origination_size: 257,
  edge_of_staking_over_delegation: 3,
  minimal_stake: 6000000000,
  denunciation_period: 1,
  slashing_delay: 1,
};

/** Same protocol, different network. The one constant that differs. */
const BAKINGNET_RAW = { ...MAINNET_RAW, blocks_per_cycle: 3600 };

const USHUAIA = 'PsUshuai9QapM5TGj1JpuVGkdxz5GykdnEvS6Rh8SUVrARvZLCY';
const NEXT_PROTOCOL = 'PsNextXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

class ScriptedRpc implements RpcSource {
  chainId = 'NetXdQprcVkpaWU';
  protocolHash = USHUAIA;
  raw: Record<string, unknown> = MAINNET_RAW;
  headLevel = 14_727_151;
  constantsReads = 0;

  async getChainId() {
    return this.chainId;
  }
  async getProtocolHash() {
    return this.protocolHash;
  }
  async getRawConstants() {
    this.constantsReads += 1;
    return this.raw;
  }
  async getHeadLevel() {
    return this.headLevel;
  }
}

describe('protocol constants', () => {
  it('reads the current field names', () => {
    const constants = parseProtocolConstants(MAINNET_RAW, 'NetXdQprcVkpaWU', USHUAIA);
    expect(constants.blocksPerCycle).toBe(14400);
    expect(constants.minimalBlockDelay).toBe(6);
    expect(constants.consensusCommitteeSize).toBe(7000);
    expect(constants.hardGasLimitPerBlock).toBe(1_040_000n);
    expect(constants.maxOperationsTimeToLive).toBe(600);
    expect(cycleDurationSeconds(constants)).toBe(86_400);
  });

  it('never reads a field that Tenderbake removed', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../src/rpc/protocol-constants.ts'),
      'utf8',
    ) as string;
    // The names appear once each, in the comment and in the exported list of
    // removed fields — never inside `parseProtocolConstants`.
    const parser = source.slice(
      source.indexOf('export function parseProtocolConstants'),
      source.indexOf('export function cycleDurationSeconds'),
    );
    for (const removed of REMOVED_CONSTANT_FIELDS) {
      expect(parser).not.toContain(removed);
    }
  });

  it('names the missing field instead of defaulting it', () => {
    const { blocks_per_cycle: _omitted, ...withoutCycle } = MAINNET_RAW;
    expect(() =>
      parseProtocolConstants(withoutCycle, 'NetXdQprcVkpaWU', USHUAIA),
    ).toThrow(MissingFieldError);
    expect(() =>
      parseProtocolConstants(withoutCycle, 'NetXdQprcVkpaWU', USHUAIA),
    ).toThrow(/missing field "blocks_per_cycle"/);
  });

  it('rejects a field of the wrong shape', () => {
    expect(() =>
      parseProtocolConstants(
        { ...MAINNET_RAW, consensus_committee_size: 'many' },
        'NetXdQprcVkpaWU',
        USHUAIA,
      ),
    ).toThrow(FieldTypeError);
  });

  describe('cache', () => {
    it('is keyed by (chain_id, protocol_hash)', () => {
      expect(ProtocolConstantsProvider.cacheKey('NetXdQprcVkpaWU', USHUAIA)).toBe(
        `NetXdQprcVkpaWU@${USHUAIA}`,
      );
    });

    it('serves the second call from cache within one cycle', async () => {
      const rpc = new ScriptedRpc();
      let now = 1_000_000;
      const provider = new ProtocolConstantsProvider(rpc, { now: () => now });

      await provider.get();
      now += 86_399_000; // still inside the cycle
      await provider.get();

      expect(rpc.constantsReads).toBe(1);
    });

    it('expires after one cycle, derived from the constants themselves', async () => {
      const rpc = new ScriptedRpc();
      let now = 1_000_000;
      const provider = new ProtocolConstantsProvider(rpc, { now: () => now });

      await provider.get();
      now += 86_400_001; // blocks_per_cycle * minimal_block_delay, in ms
      await provider.get();

      expect(rpc.constantsReads).toBe(2);
    });

    it('invalidates itself the moment the protocol hash changes', async () => {
      const rpc = new ScriptedRpc();
      const provider = new ProtocolConstantsProvider(rpc, { now: () => 1_000_000 });

      const before = await provider.get();
      expect(before.blocksPerCycle).toBe(14400);
      expect(rpc.constantsReads).toBe(1);

      // Migration day: same chain, same instant, new protocol. A time-keyed
      // cache would keep serving the old values here.
      rpc.protocolHash = NEXT_PROTOCOL;
      rpc.raw = { ...MAINNET_RAW, blocks_per_cycle: 20000 };

      const after = await provider.get();
      expect(rpc.constantsReads).toBe(2);
      expect(after.blocksPerCycle).toBe(20000);
      expect(after.protocolHash).toBe(NEXT_PROTOCOL);
      expect(provider.cacheSize).toBe(1);
    });

    it('does not carry one network\'s constants onto another', async () => {
      const mainnet = new ScriptedRpc();
      const bakingnet = new ScriptedRpc();
      bakingnet.chainId = 'NetXvNVUNbWHxGt';
      bakingnet.raw = BAKINGNET_RAW;

      const fromMainnet = await new ProtocolConstantsProvider(mainnet).get();
      const fromBakingnet = await new ProtocolConstantsProvider(bakingnet).get();

      // Same protocol hash, different blocks_per_cycle. A literal in code is
      // wrong by 4x here, and nothing in the response says so.
      expect(fromMainnet.protocolHash).toBe(fromBakingnet.protocolHash);
      expect(fromMainnet.blocksPerCycle).toBe(14400);
      expect(fromBakingnet.blocksPerCycle).toBe(3600);
    });
  });
});
