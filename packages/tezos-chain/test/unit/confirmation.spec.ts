import { InvariantViolationError } from '../../src/errors';
import {
  assertSafeToResend,
  branchTtlSeconds,
  resolveOperationState,
  type HeadSource,
} from '../../src/confirmation';
import { parseProtocolConstants } from '../../src/rpc/protocol-constants';
import { TzKTHttp } from '../../src/tzkt/http';
import { FRESH_HEADERS, FakeFetch } from '../helpers/fake-fetch';
import { TEST_NETWORK } from '../helpers/network';

const CONSTANTS = parseProtocolConstants(
  {
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
  },
  'NetXdQprcVkpaWU',
  'PsUshuai9QapM5TGj1JpuVGkdxz5GykdnEvS6Rh8SUVrARvZLCY',
);

const HASH = 'opCdNE9wDRzYxKKRYuqxawTtzScJFFauXihZa7aszBHqpuZyFsk';
const OP_LEVEL = 14_718_736;
const OP_BLOCK = 'BL6qFDjSTDgC76dZVggrpyDenRVCzY1pcvQqGzSVe7DKQt9Qqnt';

const head = (level: number): HeadSource => ({ getHeadLevel: async () => level });

function operationPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      type: 'transaction',
      hash: HASH,
      level: OP_LEVEL,
      block: OP_BLOCK,
      status: 'applied',
      ...overrides,
    },
  ]);
}

function httpReturning(handler: (callIndex: number) => { status?: number; body?: string }) {
  const fake = new FakeFetch((_url, callIndex) => ({
    headers: FRESH_HEADERS(),
    ...handler(callIndex),
  }));
  return { fake, http: new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch }) };
}

describe('Tenderbake confirmation', () => {
  it('is not confirmed at L+1', async () => {
    const { http } = httpReturning(() => ({ status: 200, body: operationPayload() }));
    const outcome = await resolveOperationState(http, head(OP_LEVEL + 1), HASH, {
      branchLevel: OP_LEVEL - 1,
      constants: CONSTANTS,
    });
    expect(outcome.status).toBe('included');
  });

  it('is confirmed at L+2, after a re-read agrees on block and status', async () => {
    const { fake, http } = httpReturning(() => ({ status: 200, body: operationPayload() }));
    const outcome = await resolveOperationState(http, head(OP_LEVEL + 2), HASH, {
      branchLevel: OP_LEVEL - 1,
      constants: CONSTANTS,
    });
    expect(outcome.status).toBe('confirmed');
    expect(outcome.block).toBe(OP_BLOCK);
    // Two reads: the first find, and the re-read that actually verifies.
    expect(fake.requests).toHaveLength(2);
  });

  it('does not confirm when the re-read finds a different block', async () => {
    const { http } = httpReturning((callIndex) => ({
      status: 200,
      body:
        callIndex === 0
          ? operationPayload()
          : operationPayload({ block: 'BLotherBlockAfterAReorganisation' }),
    }));
    const outcome = await resolveOperationState(http, head(OP_LEVEL + 5), HASH, {
      branchLevel: OP_LEVEL - 1,
      constants: CONSTANTS,
    });
    // Counting blocks would have called this confirmed. Re-reading did not.
    expect(outcome.status).toBe('failed');
  });

  it('reports a non-applied operation as failed', async () => {
    const { http } = httpReturning(() => ({
      status: 200,
      body: operationPayload({ status: 'backtracked' }),
    }));
    const outcome = await resolveOperationState(http, head(OP_LEVEL + 10), HASH, {
      branchLevel: OP_LEVEL - 1,
      constants: CONSTANTS,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.chainStatus).toBe('backtracked');
  });
});

describe('the only safe moment to resend', () => {
  it('stays pending while the branch can still be included', async () => {
    const { http } = httpReturning(() => ({ status: 200, body: '[]' }));
    const branchLevel = OP_LEVEL;
    const outcome = await resolveOperationState(
      http,
      head(branchLevel + CONSTANTS.maxOperationsTimeToLive),
      HASH,
      { branchLevel, constants: CONSTANTS },
    );
    // Absence from the indexer proves nothing yet.
    expect(outcome.status).toBe('pending');
    expect(() => assertSafeToResend(outcome)).toThrow(InvariantViolationError);
    expect(() => assertSafeToResend(outcome)).toThrow(/twice/);
  });

  it('expires exactly one max_operations_time_to_live past the branch', async () => {
    const { http } = httpReturning(() => ({ status: 200, body: '[]' }));
    const branchLevel = OP_LEVEL;
    const outcome = await resolveOperationState(
      http,
      head(branchLevel + CONSTANTS.maxOperationsTimeToLive + 1),
      HASH,
      { branchLevel, constants: CONSTANTS },
    );
    expect(outcome.status).toBe('expired');
    expect(() => assertSafeToResend(outcome)).not.toThrow();
  });

  it('reads 204 with an empty body as unknown, not as an error', async () => {
    // /v1/operations/{hash}/status answers 204 for a hash it has never seen.
    const { http } = httpReturning(() => ({ status: 204 }));
    const outcome = await resolveOperationState(http, head(OP_LEVEL), HASH, {
      branchLevel: OP_LEVEL,
      constants: CONSTANTS,
    });
    expect(outcome.status).toBe('pending');
  });

  it('derives the branch lifetime from the chain: 600 blocks is one hour', () => {
    expect(branchTtlSeconds(CONSTANTS)).toBe(3600);
  });
});
