import { localForger } from '@taquito/local-forging';
import { b58Encode, encodeOpHash, PrefixV2 } from '@taquito/utils';
import { InvariantViolationError } from '@tezos-suite/chain';
import {
  RpcBatchInjector,
  assertForgedMatchesPlan,
  signatureToHex,
  type BatchTransfer,
} from '../../src/chain/injector';
import type { HeadRef, PayoutRpc, TransactionContent } from '../../src/chain/rpc';
import type { PayoutSigner } from '../../src/chain/signer';
import { blockHash, tz1, tz4 } from '../helpers/addresses';

const SOURCE = tz1(2);
const ALICE = tz1(41);
const BOB = tz4(42);
const SIGNATURE = b58Encode(Buffer.alloc(64, 1), PrefixV2.Ed25519Signature);

class RecordingRpc implements PayoutRpc {
  readonly calls: string[] = [];
  injectedBytes: string | null = null;
  hashToAnswer: string | null = null;

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
  async preapply(input: {
    protocol: string;
    branch: string;
    contents: readonly TransactionContent[];
    signature: string;
  }): Promise<unknown> {
    this.calls.push('preapply');
    expect(input.signature).toBe(SIGNATURE);
    return [];
  }
  async injectOperation(signedBytesHex: string): Promise<string> {
    this.calls.push('inject');
    this.injectedBytes = signedBytesHex;
    return this.hashToAnswer ?? encodeOpHash(signedBytesHex);
  }
}

class StubSigner implements PayoutSigner {
  signedPayloads: string[] = [];
  async publicKeyHash(): Promise<string> {
    return SOURCE;
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
