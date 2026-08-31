import { feeRate, type Mutez, type ProtocolConstants, type RewardSplit } from '@tezos-suite/chain';
import { PayoutEngine, type EstimateTransfers, type RunRequest } from '../../src/engine';
import { InMemoryPayoutStore } from '../../src/store/memory';
import type { PayoutRpc, HeadRef, TransactionContent } from '../../src/chain/rpc';
import {
  FakeChain,
  FakeInjector,
  FakeOperationState,
  FakeSigner,
  fakeEstimator,
} from './fake-chain';
import { blockHash, tz1 } from './addresses';
import { testConstants } from './constants';

export const BAKER = tz1(1);
export const PAYOUT_SOURCE = tz1(2);

class FakeRpc implements PayoutRpc {
  constructor(private readonly chain: FakeChain) {}
  async getHead(): Promise<HeadRef> {
    return {
      hash: blockHash(this.chain.headLevel),
      level: this.chain.headLevel,
      protocol: 'PsTest',
    };
  }
  async getCounter(): Promise<bigint> {
    return 1n;
  }
  async getBalance(): Promise<Mutez> {
    return this.chain.balance;
  }
  async preapply(_input: {
    protocol: string;
    branch: string;
    contents: readonly TransactionContent[];
    signature: string;
  }): Promise<unknown> {
    return [];
  }
  async injectOperation(): Promise<string> {
    throw new Error('the fake injector injects, not the fake rpc');
  }
}

export interface HarnessOptions {
  readonly split: RewardSplit;
  /** Per-cycle splits, for the tests that run two cycles in a row. */
  readonly splitFor?: (cycle: number) => RewardSplit;
  readonly constants?: ProtocolConstants;
  readonly estimate?: EstimateTransfers;
  readonly feeMutez?: Mutez;
  readonly store?: InMemoryPayoutStore;
  readonly chain?: FakeChain;
  readonly headCycle?: number;
  readonly confirmationPolls?: number;
  readonly attemptsPerBatch?: number;
}

export interface Harness {
  readonly engine: PayoutEngine;
  readonly store: InMemoryPayoutStore;
  readonly chain: FakeChain;
  readonly injector: FakeInjector;
  readonly signer: FakeSigner;
  readonly constants: ProtocolConstants;
  readonly request: RunRequest;
  /** Two levels of head movement, which is what confirmation needs. */
  settle(): void;
}

export function buildHarness(options: HarnessOptions): Harness {
  const constants = options.constants ?? testConstants();
  const chain = options.chain ?? new FakeChain();
  const store = options.store ?? new InMemoryPayoutStore();
  const signer = new FakeSigner(PAYOUT_SOURCE);
  const injector = new FakeInjector(chain, signer);

  const engine = new PayoutEngine({
    store,
    rpc: new FakeRpc(chain),
    signer,
    injector,
    operations: new FakeOperationState(chain),
    constants: async () => constants,
    loadSplit: async (_baker, cycle) =>
      options.splitFor ? options.splitFor(cycle) : options.split,
    headCycle: async () =>
      options.headCycle ??
      options.split.cycle + constants.denunciationPeriod + constants.slashingDelay + 5,
    estimate: options.estimate ?? fakeEstimator({ feeMutez: options.feeMutez ?? 500n }),
    network: 'testnet',
    sleep: async () => {
      // Confirmation needs the head to move; in the fake chain nothing else
      // moves it, so the wait is where time passes.
      chain.advance(1);
    },
    confirmationPolls: options.confirmationPolls ?? 5,
    attemptsPerBatch: options.attemptsPerBatch ?? 2,
  });

  return {
    engine,
    store,
    chain,
    injector,
    signer,
    constants,
    request: {
      bakerId: options.split.baker,
      cycle: options.split.cycle,
      actor: 'test-operator',
      source: 'unit-test',
      policy: {
        fee: feeRate(5n, 100n),
        includeBlockFees: false,
        bakerFloorMutez: 0n,
        limits: { cycleCapMutez: 10_000_000_000n },
      },
    },
    settle: () => chain.advance(3),
  };
}
