import { InvariantViolationError } from '../../src/errors';
import type { EstimatedTransfer } from '../../src/batch/estimate';
import {
  allocationBurn,
  assertBalanceCovers,
  assertBatchesFit,
  planBatches,
} from '../../src/batch/plan';
import { parseProtocolConstants } from '../../src/rpc/protocol-constants';

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

/** The gas a plain tz->tz transfer actually consumed on mainnet. */
const MEASURED_GAS = 2169n;

function transfer(index: number, overrides: Partial<EstimatedTransfer> = {}): EstimatedTransfer {
  return {
    address: `tz1recipient${index}`,
    amount: 1_000_000n,
    gasLimit: MEASURED_GAS,
    storageLimit: 0n,
    feeMutez: 477n,
    burnMutez: 0n,
    ...overrides,
  };
}

describe('batch sizing', () => {
  it('fills a batch by accumulated gas, not by a fixed operation count', () => {
    const transfers = Array.from({ length: 1000 }, (_, index) => transfer(index));
    const plan = planBatches(transfers, CONSTANTS, { blockGasUtilisationPercent: 90 });

    // 90% of 1 040 000 is 936 000; at 2169 gas that is 431 operations, close
    // to the 448-operation batch measured on mainnet at 90.6% of the block.
    expect(plan.batches[0]!.transfers).toHaveLength(431);
    expect(plan.batches).toHaveLength(3);
    for (const batch of plan.batches) {
      expect(batch.totalGas).toBeLessThanOrEqual(CONSTANTS.hardGasLimitPerBlock);
    }
    expect(() => assertBatchesFit(plan, CONSTANTS)).not.toThrow();
  });

  it('produces far fewer batches than a hard limit of 100 operations would', () => {
    const transfers = Array.from({ length: 2919 }, (_, index) => transfer(index));
    const byGas = planBatches(transfers, CONSTANTS);
    const byFixedCount = planBatches(transfers, CONSTANTS, { maxOperationsPerBatch: 100 });

    expect(byGas.batches).toHaveLength(7);
    expect(byFixedCount.batches).toHaveLength(30);
  });

  it('refuses an operation over the per-operation ceiling', () => {
    expect(() =>
      planBatches([transfer(0, { gasLimit: CONSTANTS.hardGasLimitPerOperation + 1n })], CONSTANTS),
    ).toThrow(/hard_gas_limit_per_operation/);
  });

  it('refuses three operations at the full per-operation ceiling', () => {
    // Measured: three operations with gas_limit=1040000 each are rejected with
    // gas_limit_too_high + gas_exhausted.block. The sum is what binds.
    const maxed = Array.from({ length: 3 }, (_, index) =>
      transfer(index, { gasLimit: CONSTANTS.hardGasLimitPerOperation }),
    );
    expect(() => planBatches(maxed, CONSTANTS)).toThrow(
      /a single operation fits in the batch gas budget/,
    );
    // Even at full utilisation they must land in three separate batches.
    const plan = planBatches(maxed, CONSTANTS, { blockGasUtilisationPercent: 100 });
    expect(plan.batches).toHaveLength(3);
  });

  it('carries the storage the estimate reported, including the allocation burn', () => {
    // storage_limit: 0 against a destination that is not allocated makes the
    // whole batch come back backtracked — the other recipients show no error.
    expect(allocationBurn(CONSTANTS)).toBe(64_250n);

    const plan = planBatches(
      [
        transfer(0),
        transfer(1, {
          storageLimit: BigInt(CONSTANTS.originationSize),
          burnMutez: allocationBurn(CONSTANTS),
        }),
      ],
      CONSTANTS,
    );
    expect(plan.batches[0]!.totalStorage).toBe(257n);
    expect(plan.batches[0]!.totalBurn).toBe(64_250n);
  });

  it('refuses storage over the per-operation ceiling', () => {
    expect(() =>
      planBatches(
        [transfer(0, { storageLimit: CONSTANTS.hardStorageLimitPerOperation + 1n })],
        CONSTANTS,
      ),
    ).toThrow(/hard_storage_limit_per_operation/);
  });
});

describe('funding', () => {
  it('adds amounts, fees and burns into the cost the baker must cover', () => {
    const plan = planBatches(
      [transfer(0), transfer(1, { burnMutez: 64_250n, storageLimit: 257n })],
      CONSTANTS,
    );
    expect(plan.totalCost).toBe(1_000_000n + 477n + 1_000_000n + 477n + 64_250n);
  });

  it('aborts before signing when the balance is short', () => {
    const plan = planBatches([transfer(0)], CONSTANTS);
    expect(() => assertBalanceCovers(plan, plan.totalCost)).not.toThrow();
    expect(() => assertBalanceCovers(plan, plan.totalCost - 1n)).toThrow(
      InvariantViolationError,
    );
    expect(() => assertBalanceCovers(plan, plan.totalCost - 1n)).toThrow(/short of/);
  });
});
