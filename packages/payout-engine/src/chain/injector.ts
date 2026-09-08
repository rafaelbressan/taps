import { localForger } from '@taquito/local-forging';
import { b58DecodeAndCheckPrefix, buf2hex, encodeOpHash, signaturePrefixes } from '@taquito/utils';
import { InvariantViolationError, type Mutez, type RevealCost } from '@tezos-suite/chain';
import type { HeadRef, PayoutRpc, RevealContent, TransactionContent } from './rpc';
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
  /**
   * Hash of the reveal that had to go first, when one did.
   *
   * Its own operation, injected before the batch and never inside it — see
   * `RevealContent`. Reported so the trail can show it.
   */
  readonly revealOpHash: string | null;
}

export interface BatchInjector {
  /**
   * `reveal` is the cost of publishing the source's public key, and is only
   * consulted when the chain says the account has never published one.
   */
  prepare(
    transfers: readonly BatchTransfer[],
    reveal?: RevealCost | null,
  ): Promise<PreparedBatch>;
  inject(prepared: PreparedBatch): Promise<string>;
}

export interface RpcBatchInjectorOptions {
  /** Dry-run against the node before injecting. On by default. */
  readonly preapply?: boolean;
  /**
   * How many times to ask the chain whether the reveal has landed, and how
   * long to wait between asks.
   *
   * `preapply` validates against the head BLOCK, not the mempool: while the
   * reveal is only in the mempool the batch's counter is still "in the
   * future" and the node refuses it. So the reveal is waited for — once per
   * account, ever (BRES-137).
   */
  readonly revealPolls?: number;
  readonly revealPollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
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
  private readonly revealPolls: number;
  private readonly revealPollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly rpc: PayoutRpc,
    private readonly signer: PayoutSigner,
    options: RpcBatchInjectorOptions = {},
  ) {
    this.withPreapply = options.preapply ?? true;
    this.revealPolls = options.revealPolls ?? 40;
    this.revealPollIntervalMs = options.revealPollIntervalMs ?? 3_000;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async prepare(
    transfers: readonly BatchTransfer[],
    reveal?: RevealCost | null,
  ): Promise<PreparedBatch> {
    if (transfers.length === 0) {
      throw new InvariantViolationError(
        'a batch has at least one transfer',
        'refusing to forge an empty operation',
      );
    }

    const source = await this.signer.publicKeyHash();
    const [head, counter, managerKey] = await Promise.all([
      this.rpc.getHead(),
      this.rpc.getCounter(source),
      this.rpc.getManagerKey(source),
    ]);

    // An account that never published its public key cannot send anything,
    // and that is the state every payout key is in on the day it is made.
    // The reveal goes first, on its own, and the batch counter starts after
    // it — the batch bytes stay exactly what they would have been.
    let revealOpHash: string | null = null;
    let firstCounter = counter + 1n;
    if (managerKey === null) {
      if (!reveal) {
        throw new InvariantViolationError(
          'the cost of the reveal is known before the account is revealed',
          `${source} has never been revealed and no reveal estimate reached the injector. ` +
            'A resumed run rebuilds the batch from the store, where no estimate lives; ' +
            `reveal the account once with \`octez-client reveal key for <alias>\` and the ` +
            'run continues on its own.',
        );
      }
      revealOpHash = await this.revealSource(source, head, counter + 1n, reveal);
      firstCounter = counter + 2n;
    }

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
        counter: (firstCounter + BigInt(index)).toString(),
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
      firstCounter,
      revealOpHash,
      contents,
      forgedBytes,
      signature,
      signedBytes,
      opHash,
    };
  }

  /**
   * Reveals the paying account and returns the operation hash.
   *
   * The public key comes from the signer that holds the secret one, not from
   * configuration: a configured copy can disagree with the key that actually
   * signs, and the account would be revealed under the wrong key.
   */
  private async revealSource(
    source: string,
    head: HeadRef,
    counter: bigint,
    reveal: RevealCost,
  ): Promise<string> {
    const publicKey = await this.signer.publicKey();
    const { content, forgedBytes } = await forgeReveal(
      source,
      publicKey,
      head.hash,
      counter,
      reveal,
    );
    const signature = await this.signer.signOperation(forgedBytes);
    if (this.withPreapply) {
      await this.rpc.preapply({
        protocol: head.protocol,
        branch: head.hash,
        contents: [content],
        signature,
      });
    }
    const opHash = await this.rpc.injectOperation(forgedBytes + signatureToHex(signature));

    // Waited for, not assumed. Until the reveal is in a block the node's view
    // of the account's counter has not moved, and the batch that follows it
    // reads as `counter_in_the_future`.
    for (let poll = 0; poll < this.revealPolls; poll += 1) {
      await this.sleep(this.revealPollIntervalMs);
      if ((await this.rpc.getManagerKey(source)) !== null) return opHash;
    }
    throw new InvariantViolationError(
      'the reveal is in a block before the batch that depends on it is built',
      `${source} was revealed by ${opHash}, and after ${this.revealPolls} tries the chain ` +
        'still does not show the key. The operation may yet be included; running again picks ' +
        'up where this stopped.',
    );
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
 * Publishes the source's public key, as its own operation.
 *
 * Same discipline as a batch and for the same reason — the bytes are forged
 * here, parsed back, and only then signed. A reveal is a cheap operation, but
 * it is still bytes the payout key puts its name on, and "the signer will
 * sign whatever it is handed" is the assumption this whole module exists to
 * avoid.
 */
async function forgeReveal(
  source: string,
  publicKey: string,
  branch: string,
  counter: bigint,
  reveal: RevealCost,
): Promise<{ content: RevealContent; forgedBytes: string }> {
  const content: RevealContent = {
    kind: 'reveal',
    source,
    fee: reveal.feeMutez.toString(),
    counter: counter.toString(),
    gas_limit: reveal.gasLimit.toString(),
    // A reveal allocates nothing. Anything above zero here would be a
    // number nobody can explain.
    storage_limit: '0',
    public_key: publicKey,
  };
  const forgedBytes = await localForger.forge({
    branch,
    contents: [content] as unknown as Parameters<typeof localForger.forge>[0]['contents'],
  });
  const parsed = await localForger.parse(forgedBytes);
  const back = parsed.contents[0] as Record<string, unknown> | undefined;
  if (!back || back['kind'] !== 'reveal') {
    throw new InvariantViolationError(
      'the forged reveal is a reveal',
      `forged a ${JSON.stringify(back?.['kind'])}`,
    );
  }
  if (back['source'] !== source || back['public_key'] !== publicKey) {
    throw new InvariantViolationError(
      'the forged reveal names the paying account and its own key',
      `forged ${String(back['source'])} / ${String(back['public_key'])}, ` +
        `planned ${source} / ${publicKey}`,
    );
  }
  return { content, forgedBytes };
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
