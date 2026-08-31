import { encodeOpHash } from '@taquito/utils';
import type {
  EstimatedTransfer,
  Mutez,
  OperationOutcome,
  ProtocolConstants,
  Recipient,
} from '@tezos-suite/chain';
import type { BatchInjector, BatchTransfer, PreparedBatch } from '../../src/chain/injector';
import type { PayoutSigner } from '../../src/chain/signer';
import type { OperationStateSource } from '../../src/engine';
import { blockHash } from './addresses';

/**
 * A chain small enough to reason about and honest about the two moments that
 * matter: the gap between "signed" and "injected", and the gap between
 * "injected" and "two levels deep".
 */
export class FakeChain {
  headLevel = 1_000;
  balance: Mutez = 1_000_000_000_000n;
  /** Hashes the chain has actually seen. */
  readonly injected = new Map<string, { level: number; status: string }>();
  /** Every hash a caller prepared, injected or not. */
  readonly prepared: string[] = [];
  /** Set to make `inject` throw before the chain sees anything. */
  failNextInjection: Error | null = null;
  /**
   * The dangerous one: the operation LANDS and the caller still sees an
   * error. This is the lost confirmation that makes a naive retry pay twice.
   */
  landThenFailNextInjection = false;
  /** Set to make the injected operation land as something other than applied. */
  nextInjectionStatus = 'applied';

  advance(levels = 3): void {
    this.headLevel += levels;
  }

  record(hash: string): void {
    this.injected.set(hash, { level: this.headLevel, status: this.nextInjectionStatus });
  }
}

export class FakeSigner implements PayoutSigner {
  constructor(private readonly pkh: string) {}
  readonly signed: string[] = [];

  async publicKeyHash(): Promise<string> {
    return this.pkh;
  }

  async signOperation(forgedBytesHex: string): Promise<string> {
    this.signed.push(forgedBytesHex);
    return 'edsig-fake';
  }
}

/**
 * Injector that produces a real operation hash from the bytes it would send,
 * so the hash is a function of the batch and two different batches cannot
 * collide by accident.
 */
export class FakeInjector implements BatchInjector {
  constructor(
    private readonly chain: FakeChain,
    private readonly signer: PayoutSigner,
  ) {}

  readonly preparedBatches: PreparedBatch[] = [];
  private nonce = 0;

  async prepare(transfers: readonly BatchTransfer[]): Promise<PreparedBatch> {
    const source = await this.signer.publicKeyHash();
    this.nonce += 1;
    const body = transfers
      .map((t) => `${t.address}:${t.amount}:${t.feeMutez}:${t.gasLimit}:${t.storageLimit}`)
      .join('|');
    // The branch is part of the operation, so a resend on a newer branch has
    // a different hash — exactly as it does on chain.
    const branch = blockHash(this.chain.headLevel);
    const bytes = Buffer.from(`${source}|${branch}|${this.nonce}|${body}`).toString('hex');
    const opHash = encodeOpHash(bytes.padEnd(200, '0'));
    await this.signer.signOperation(bytes);
    const prepared: PreparedBatch = {
      branch,
      branchLevel: this.chain.headLevel,
      protocol: 'PsTestProtocolHashForUnitTestsOnly000000000000',
      firstCounter: BigInt(this.nonce),
      contents: [],
      forgedBytes: bytes,
      signature: 'edsig-fake',
      signedBytes: bytes,
      opHash,
    };
    this.chain.prepared.push(opHash);
    this.preparedBatches.push(prepared);
    return prepared;
  }

  async inject(prepared: PreparedBatch): Promise<string> {
    if (this.chain.failNextInjection) {
      const error = this.chain.failNextInjection;
      this.chain.failNextInjection = null;
      throw error;
    }
    if (this.chain.landThenFailNextInjection) {
      this.chain.landThenFailNextInjection = false;
      this.chain.record(prepared.opHash);
      throw new Error('connection reset after the node accepted the operation');
    }
    this.chain.record(prepared.opHash);
    return prepared.opHash;
  }
}

/** Reproduces the state machine of the real source, over the fake chain. */
export class FakeOperationState implements OperationStateSource {
  constructor(private readonly chain: FakeChain) {}

  async resolve(
    opHash: string,
    branchLevel: number,
    constants: ProtocolConstants,
  ): Promise<OperationOutcome> {
    const found = this.chain.injected.get(opHash);
    const headLevel = this.chain.headLevel;
    if (!found) {
      const expiry = branchLevel + constants.maxOperationsTimeToLive;
      return { hash: opHash, status: headLevel > expiry ? 'expired' : 'pending', headLevel };
    }
    if (found.status !== 'applied') {
      return {
        hash: opHash,
        status: 'failed',
        level: found.level,
        chainStatus: found.status,
        headLevel,
      };
    }
    if (headLevel < found.level + 2) {
      return { hash: opHash, status: 'included', level: found.level, headLevel };
    }
    return { hash: opHash, status: 'confirmed', level: found.level, headLevel };
  }
}

export interface FakeEstimatorOptions {
  /** Fee per transfer, in mutez. Varied by tests to move the payout cut. */
  readonly feeMutez: Mutez;
  readonly gasLimit?: bigint;
  /** Storage granted to a destination that needs allocating. */
  readonly allocationStorage?: bigint;
  readonly allocationBurn?: Mutez;
}

/**
 * Stands in for `estimate.batch()`. It returns storage for the destinations
 * that need allocating — which is exactly what the real node does and what
 * the current TAPS overrides with a fixed zero.
 */
export function fakeEstimator(options: FakeEstimatorOptions) {
  return async (recipients: readonly Recipient[]): Promise<EstimatedTransfer[]> =>
    recipients.map((recipient) => ({
      address: recipient.address,
      amount: recipient.amount,
      gasLimit: options.gasLimit ?? 2169n,
      storageLimit: recipient.emptied ? (options.allocationStorage ?? 257n) : 0n,
      feeMutez: options.feeMutez,
      burnMutez: recipient.emptied ? (options.allocationBurn ?? 64_250n) : 0n,
    }));
}
