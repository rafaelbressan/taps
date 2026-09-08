import { localForger } from '@taquito/local-forging';
import { b58Encode, encodeOpHash, PrefixV2 } from '@taquito/utils';
import { InvariantViolationError } from '@tezos-suite/chain';
import {
  RpcBatchInjector,
  assertForgedMatchesPlan,
  signatureToHex,
  type BatchTransfer,
} from '../../src/chain/injector';
import type { HeadRef, OperationContent, PayoutRpc } from '../../src/chain/rpc';
import type { PayoutSigner } from '../../src/chain/signer';
import { blockHash, tz1, tz4 } from '../helpers/addresses';

const SOURCE = tz1(2);
const ALICE = tz1(41);
const BOB = tz4(42);
const SIGNATURE = b58Encode(Buffer.alloc(64, 1), PrefixV2.Ed25519Signature);
const PUBLIC_KEY = b58Encode(Buffer.alloc(32, 7), PrefixV2.Ed25519PublicKey);

class RecordingRpc implements PayoutRpc {
  readonly calls: string[] = [];
  injectedBytes: string | null = null;
  hashToAnswer: string | null = null;
  /** `null` is an account that never published its public key. */
  managerKey: string | null = 'edpkTestManagerKey';
  readonly injectedOperations: string[] = [];

  async getHead(): Promise<HeadRef> {
    this.calls.push('head');
    return { hash: blockHash(500), level: 500, protocol: 'PsTestProtocol' };
  }
  async getCounter(): Promise<bigint> {
    this.calls.push('counter');
    return 41n;
  }
  async getBalance(): Promise<bigint> {
    return 10_000_000n;
  }
  async getManagerKey(): Promise<string | null> {
    this.calls.push('manager_key');
    return this.managerKey;
  }
  async preapply(input: {
    protocol: string;
    branch: string;
    contents: readonly OperationContent[];
    signature: string;
  }): Promise<unknown> {
    this.calls.push('preapply');
    expect(input.signature).toBe(SIGNATURE);
    return [];
  }
  async injectOperation(signedBytesHex: string): Promise<string> {
    this.calls.push('inject');
    this.injectedBytes = signedBytesHex;
    this.injectedOperations.push(signedBytesHex);
    // The first injection on an unrevealed account is the reveal, and the
    // chain shows the key from the next block on. The injector waits for
    // exactly that, so the double has to do it too.
    if (this.managerKey === null) this.managerKey = 'edpkRevealedNow';
    return this.hashToAnswer ?? encodeOpHash(signedBytesHex);
  }
}

class StubSigner implements PayoutSigner {
  signedPayloads: string[] = [];
  async publicKeyHash(): Promise<string> {
    return SOURCE;
  }
  async publicKey(): Promise<string> {
    return PUBLIC_KEY;
  }
  async signOperation(forgedBytesHex: string): Promise<string> {
    this.signedPayloads.push(forgedBytesHex);
    return SIGNATURE;
  }
}

const transfers: BatchTransfer[] = [
  { address: ALICE, amount: 1_000_000n, feeMutez: 488n, gasLimit: 2_169n, storageLimit: 0n },
  { address: BOB, amount: 2_500_000n, feeMutez: 488n, gasLimit: 2_169n, storageLimit: 257n },
];

describe('the operation hash exists before the operation does', () => {
  it('produces the hash from the signed bytes, with nothing injected yet', async () => {
    const rpc = new RecordingRpc();
    const injector = new RpcBatchInjector(rpc, new StubSigner());

    const prepared = await injector.prepare(transfers);

    expect(rpc.calls).not.toContain('inject');
    expect(prepared.opHash).toBe(encodeOpHash(prepared.signedBytes));
    expect(prepared.signedBytes).toBe(prepared.forgedBytes + signatureToHex(SIGNATURE));
    expect(prepared.branchLevel).toBe(500);
    // Counters are consecutive from the account's next counter.
    expect(prepared.contents.map((c) => c.counter)).toEqual(['42', '43']);
  });

  it('preapplies before it injects', async () => {
    const rpc = new RecordingRpc();
    const injector = new RpcBatchInjector(rpc, new StubSigner());
    const prepared = await injector.prepare(transfers);
    await injector.inject(prepared);
    expect(rpc.calls.indexOf('preapply')).toBeLessThan(rpc.calls.indexOf('inject'));
  });

  it('signs bytes it forged itself, and they say what the plan says', async () => {
    const signer = new StubSigner();
    const injector = new RpcBatchInjector(new RecordingRpc(), signer);
    const prepared = await injector.prepare(transfers);

    const parsed = await localForger.parse(signer.signedPayloads[0]!);
    expect(parsed.contents.map((c) => (c as { destination: string }).destination)).toEqual([
      ALICE,
      BOB,
    ]);
    expect(parsed.contents.map((c) => (c as { amount: string }).amount)).toEqual([
      '1000000',
      '2500000',
    ]);
    // tz4 is a payable destination; the storage limit for the emptied one is
    // the one the estimate gave, not a fixed zero.
    expect((parsed.contents[1] as { storage_limit: string }).storage_limit).toBe('257');
    expect(prepared.contents[1]?.destination).toBe(BOB);
  });

  it('refuses to inject when the node reports a different hash', async () => {
    const rpc = new RecordingRpc();
    rpc.hashToAnswer = 'ooNotTheHashWeRecorded';
    const injector = new RpcBatchInjector(rpc, new StubSigner());
    const prepared = await injector.prepare(transfers);
    await expect(injector.inject(prepared)).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('refuses an empty batch and a non-positive amount', async () => {
    const injector = new RpcBatchInjector(new RecordingRpc(), new StubSigner());
    await expect(injector.prepare([])).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      injector.prepare([{ ...transfers[0]!, amount: 0n }]),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });
});

describe('the forged bytes are checked against the plan', () => {
  it('passes when they agree', async () => {
    const forged = await localForger.forge({
      branch: blockHash(500),
      contents: transfers.map((t, index) => ({
        kind: 'transaction',
        source: SOURCE,
        fee: t.feeMutez.toString(),
        counter: (42 + index).toString(),
        gas_limit: t.gasLimit.toString(),
        storage_limit: t.storageLimit.toString(),
        amount: t.amount.toString(),
        destination: t.address,
      })) as never,
    });
    await expect(assertForgedMatchesPlan(forged, transfers)).resolves.toBeUndefined();
  });

  it('fails when the bytes pay someone else', async () => {
    const attacker = tz1(4242);
    const forged = await localForger.forge({
      branch: blockHash(500),
      contents: [
        {
          kind: 'transaction',
          source: SOURCE,
          fee: '488',
          counter: '42',
          gas_limit: '2169',
          storage_limit: '0',
          amount: '1000000',
          destination: attacker,
        },
      ] as never,
    });
    await expect(assertForgedMatchesPlan(forged, [transfers[0]!])).rejects.toThrow(
      /forged destination/,
    );
  });

  it('fails when the bytes move a different amount', async () => {
    const forged = await localForger.forge({
      branch: blockHash(500),
      contents: [
        {
          kind: 'transaction',
          source: SOURCE,
          fee: '488',
          counter: '42',
          gas_limit: '2169',
          storage_limit: '0',
          amount: '999999999',
          destination: ALICE,
        },
      ] as never,
    });
    await expect(assertForgedMatchesPlan(forged, [transfers[0]!])).rejects.toThrow(
      /forged amount/,
    );
  });

  it('fails when the batch is shorter than the plan', async () => {
    const forged = await localForger.forge({
      branch: blockHash(500),
      contents: [
        {
          kind: 'transaction',
          source: SOURCE,
          fee: '488',
          counter: '42',
          gas_limit: '2169',
          storage_limit: '0',
          amount: '1000000',
          destination: ALICE,
        },
      ] as never,
    });
    await expect(assertForgedMatchesPlan(forged, transfers)).rejects.toThrow(
      /one transfer per planned recipient/,
    );
  });
});

/**
 * The first payout of a payout key that was just created (BRES-137).
 *
 * A Tezos account has to publish its public key once before it can send
 * anything. Before this, the estimate came back with one entry more than it
 * was asked for and the run died on an invariant about counting — so the
 * first payment a new baker ever attempted was the one that could not work,
 * and the sentence it failed with was about arithmetic.
 */
/** No wall-clock in a unit test; the waiting itself has its own test below. */
const INSTANT_REVEAL = { revealPollIntervalMs: 0, sleep: async () => {} };

describe('an account that never published its public key', () => {
  it('reveals it first, as its own operation, and starts the batch after it', async () => {
    const rpc = new RecordingRpc();
    rpc.managerKey = null;
    const signer = new StubSigner();
    const injector = new RpcBatchInjector(rpc, signer, INSTANT_REVEAL);

    const prepared = await injector.prepare(transfers, {
      gasLimit: 1_000n,
      storageLimit: 0n,
      feeMutez: 374n,
    });

    // The reveal went out on its own, before anything was forged for the batch.
    expect(rpc.injectedOperations).toHaveLength(1);
    expect(prepared.revealOpHash).not.toBeNull();

    // And the batch counters start after it: counter 41 + reveal 42 + first
    // transfer 43. A batch that reused 42 would be refused by the node.
    expect(prepared.firstCounter).toBe(43n);
    expect(prepared.contents[0]!.counter).toBe('43');
    expect(prepared.contents[1]!.counter).toBe('44');

    // The batch itself is still nothing but transfers. That is what lets a
    // resumed run rebuild the same bytes and keep the same hash.
    expect(prepared.contents.every((c) => c.kind === 'transaction')).toBe(true);
  });

  it('reveals under the key the signer actually holds, not a configured one', async () => {
    const rpc = new RecordingRpc();
    rpc.managerKey = null;
    const signer = new StubSigner();
    const injector = new RpcBatchInjector(rpc, signer, INSTANT_REVEAL);

    await injector.prepare(transfers, {
      gasLimit: 1_000n,
      storageLimit: 0n,
      feeMutez: 374n,
    });

    // Two signatures: the reveal and the batch. The reveal is the first, and
    // its bytes parse back to a reveal of this source under this key.
    expect(signer.signedPayloads).toHaveLength(2);
    const parsed = await localForger.parse(signer.signedPayloads[0]!);
    const content = parsed.contents[0] as unknown as Record<string, unknown>;
    expect(content['kind']).toBe('reveal');
    expect(content['source']).toBe(SOURCE);
    expect(content['public_key']).toBe(PUBLIC_KEY);
  });

  it('refuses when nobody priced the reveal, and says which account', async () => {
    const rpc = new RecordingRpc();
    rpc.managerKey = null;
    const injector = new RpcBatchInjector(rpc, new StubSigner(), INSTANT_REVEAL);

    // This is the resumed-run corner: the batch comes from the store, where
    // no estimate lives. Refusing with the account named beats guessing a fee.
    await expect(injector.prepare(transfers)).rejects.toThrow(SOURCE);
    expect(rpc.injectedOperations).toHaveLength(0);
  });

  it('leaves a revealed account alone', async () => {
    const rpc = new RecordingRpc();
    const injector = new RpcBatchInjector(rpc, new StubSigner(), INSTANT_REVEAL);

    const prepared = await injector.prepare(transfers, {
      gasLimit: 1_000n,
      storageLimit: 0n,
      feeMutez: 374n,
    });

    // A reveal estimate left over from an earlier pass must not produce a
    // second reveal: the chain already has the key.
    expect(rpc.injectedOperations).toHaveLength(0);
    expect(prepared.revealOpHash).toBeNull();
    expect(prepared.firstCounter).toBe(42n);
  });
});

describe('the batch waits for the reveal to be in a block', () => {
  it('polls the chain until the key shows, then forges the batch', async () => {
    const rpc = new RecordingRpc();
    rpc.managerKey = null;
    // Three polls before the chain admits it. `preapply` validates against
    // the head BLOCK, so forging earlier gets `counter_in_the_future` — the
    // exact error a real shadownet run gave before this wait existed.
    let landsAfter = 3;
    const injected = rpc.injectOperation.bind(rpc);
    rpc.injectOperation = async (bytes: string) => {
      const hash = await injected(bytes);
      rpc.managerKey = null;
      return hash;
    };
    const sleeps: number[] = [];
    const injector = new RpcBatchInjector(rpc, new StubSigner(), {
      revealPollIntervalMs: 7,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= landsAfter) rpc.managerKey = 'edpkRevealedNow';
      },
    });

    const prepared = await injector.prepare(transfers, {
      gasLimit: 1_000n,
      storageLimit: 0n,
      feeMutez: 374n,
    });

    expect(sleeps).toHaveLength(3);
    expect(prepared.firstCounter).toBe(43n);
  });

  it('gives up with the reveal hash rather than forging a doomed batch', async () => {
    const rpc = new RecordingRpc();
    rpc.managerKey = null;
    const injected = rpc.injectOperation.bind(rpc);
    rpc.injectOperation = async (bytes: string) => {
      const hash = await injected(bytes);
      rpc.managerKey = null; // never lands
      return hash;
    };
    const injector = new RpcBatchInjector(rpc, new StubSigner(), {
      revealPolls: 2,
      revealPollIntervalMs: 0,
      sleep: async () => {},
    });

    // The hash has to be in the message: the reveal may still be included,
    // and the operator needs to be able to look it up.
    await expect(
      injector.prepare(transfers, { gasLimit: 1_000n, storageLimit: 0n, feeMutez: 374n }),
    ).rejects.toThrow(/was revealed by o/);
  });
});
