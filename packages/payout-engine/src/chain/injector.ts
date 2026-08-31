import { localForger } from '@taquito/local-forging';
import { b58DecodeAndCheckPrefix, buf2hex, encodeOpHash, signaturePrefixes } from '@taquito/utils';
import { InvariantViolationError, type Mutez } from '@tezos-suite/chain';
import type { PayoutRpc, TransactionContent } from './rpc';
import type { PayoutSigner } from './signer';

/**
 * Injection, split so that the operation hash exists BEFORE the operation
 * does.
 *
 * `batch().send()` forges, signs and injects in one call and hands back a
 * hash only once the node has accepted it. If the process dies in the middle,
 * or the answer is lost, there is no hash to look up and the next run cannot
 * tell "never injected" from "injected, answer lost" — and that is exactly
 * where a retry pays twice.
 *
 * The hash of a Tezos operation is `blake2b` of the SIGNED bytes, so it is
 * known the moment the signature comes back and before anything is sent. The
 * split below is the whole point: `prepare()` produces the hash, the caller
 * persists it, and only then `inject()` runs.
 */

export interface BatchTransfer {
  readonly address: string;
  readonly amount: Mutez;
  readonly feeMutez: Mutez;
  readonly gasLimit: bigint;
  readonly storageLimit: bigint;
}

export interface PreparedBatch {
  readonly branch: string;
  readonly branchLevel: number;
  readonly protocol: string;
  readonly firstCounter: bigint;
  readonly contents: readonly TransactionContent[];
  readonly forgedBytes: string;
  readonly signature: string;
  readonly signedBytes: string;
  /** Known before injection. This is what makes the retry safe. */
  readonly opHash: string;
}

export interface BatchInjector {
  prepare(transfers: readonly BatchTransfer[]): Promise<PreparedBatch>;
  inject(prepared: PreparedBatch): Promise<string>;
}

export interface RpcBatchInjectorOptions {
  /** Dry-run against the node before injecting. On by default. */
  readonly preapply?: boolean;
}

/**
 * Forges LOCALLY.
 *
 * Asking the node to forge and then signing what comes back means signing
 * bytes the node chose. The destinations were checked against the delegator
 * list, but the check was on the plan, not on the bytes. Forging here and
 * parsing the result back closes the gap: what gets signed is provably the
 * plan.
 */
export class RpcBatchInjector implements BatchInjector {
  private readonly withPreapply: boolean;

  constructor(
    private readonly rpc: PayoutRpc,
    private readonly signer: PayoutSigner,
    options: RpcBatchInjectorOptions = {},
  ) {
    this.withPreapply = options.preapply ?? true;
  }

  async prepare(transfers: readonly BatchTransfer[]): Promise<PreparedBatch> {
    if (transfers.length === 0) {
      throw new InvariantViolationError(
        'a batch has at least one transfer',
        'refusing to forge an empty operation',
      );
    }

    const source = await this.signer.publicKeyHash();
    const [head, counter] = await Promise.all([
      this.rpc.getHead(),
      this.rpc.getCounter(source),
    ]);

    const contents = transfers.map((transfer, index): TransactionContent => {
      if (transfer.amount <= 0n) {
        throw new InvariantViolationError(
          'every transfer in a batch moves a positive amount',
          `${transfer.address} would move ${transfer.amount} mutez`,
        );
      }
      return {
        kind: 'transaction',
        source,
        fee: transfer.feeMutez.toString(),
        counter: (counter + BigInt(index) + 1n).toString(),
        gas_limit: transfer.gasLimit.toString(),
        storage_limit: transfer.storageLimit.toString(),
        amount: transfer.amount.toString(),
        destination: transfer.address,
      };
    });

    // `localForger` types `kind` as its own enum; the wire value is the same
    // string, and the parse-back check below is what actually guarantees the
    // bytes say what the plan says.
    const forgedBytes = await localForger.forge({
      branch: head.hash,
      contents: contents as unknown as Parameters<typeof localForger.forge>[0]['contents'],
    });
    await assertForgedMatchesPlan(forgedBytes, transfers);

    const signature = await this.signer.signOperation(forgedBytes);
    const signedBytes = forgedBytes + signatureToHex(signature);
    const opHash = encodeOpHash(signedBytes);

    if (this.withPreapply) {
      await this.rpc.preapply({
        protocol: head.protocol,
        branch: head.hash,
        contents,
        signature,
      });
    }

    return {
      branch: head.hash,
      branchLevel: head.level,
      protocol: head.protocol,
      firstCounter: counter + 1n,
      contents,
      forgedBytes,
      signature,
      signedBytes,
      opHash,
    };
  }

  async inject(prepared: PreparedBatch): Promise<string> {
    const hash = await this.rpc.injectOperation(prepared.signedBytes);
    if (hash !== prepared.opHash) {
      // The node cannot disagree about the hash of bytes it was handed. If it
      // does, the bytes that were persisted are not the bytes that were sent.
      throw new InvariantViolationError(
        'the injected hash equals the hash recorded before injection',
        `recorded ${prepared.opHash}, node answered ${hash}`,
      );
    }
    return hash;
  }
}

/**
 * Reads the forged bytes back and compares them with the plan, field by
 * field. A forging bug or a substituted byte string is caught before the
 * signature is asked for, which is the last moment it is still free.
 */
export async function assertForgedMatchesPlan(
  forgedBytes: string,
  transfers: readonly BatchTransfer[],
): Promise<void> {
  const parsed = await localForger.parse(forgedBytes);
  const contents = parsed.contents;
  if (contents.length !== transfers.length) {
    throw new InvariantViolationError(
      'the forged operation has one transfer per planned recipient',
      `planned ${transfers.length}, forged ${contents.length}`,
    );
  }
  for (const [index, transfer] of transfers.entries()) {
    const content = contents[index] as Record<string, unknown> | undefined;
    if (!content || content['kind'] !== 'transaction') {
      throw new InvariantViolationError(
        'every forged content is a transaction',
        `position ${index} is ${JSON.stringify(content?.['kind'])}`,
      );
    }
    if (content['destination'] !== transfer.address) {
      throw new InvariantViolationError(
        'the forged destination is the planned destination',
        `position ${index}: forged ${String(content['destination'])}, planned ${transfer.address}`,
      );
    }
    if (content['amount'] !== transfer.amount.toString()) {
      throw new InvariantViolationError(
        'the forged amount is the planned amount',
        `${transfer.address}: forged ${String(content['amount'])}, planned ${transfer.amount}`,
      );
    }
  }
}

/** Base58 signature to the raw hex the injection payload carries. */
export function signatureToHex(signature: string): string {
  return buf2hex(
    Buffer.from(b58DecodeAndCheckPrefix(signature, signaturePrefixes, true)),
  );
}
