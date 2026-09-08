import { FieldTypeError, HttpError, type Mutez } from '@tezos-suite/chain';

/**
 * The slice of the Octez RPC the payout path needs, as an interface.
 *
 * Narrow on purpose: everything here either reads a value the engine cannot
 * invent (head, counter, balance) or moves the operation along its last two
 * steps (preapply, inject). Nothing that decides an amount lives behind it.
 */

export interface TransactionContent {
  readonly kind: 'transaction';
  readonly source: string;
  readonly fee: string;
  readonly counter: string;
  readonly gas_limit: string;
  readonly storage_limit: string;
  readonly amount: string;
  readonly destination: string;
}

/**
 * Publishing the paying account's public key. Once per account, ever.
 *
 * It is deliberately NOT part of a payout batch. The batch's operation hash
 * is written to the store before the operation exists, and that is what makes
 * a retry safe; a resumed run rebuilds the batch from the store, where no
 * estimate is available, so a batch that carried a reveal could not be
 * rebuilt byte-for-byte. Keeping the reveal outside leaves the payout bytes
 * identical on every attempt (BRES-137).
 */
export interface RevealContent {
  readonly kind: 'reveal';
  readonly source: string;
  readonly fee: string;
  readonly counter: string;
  readonly gas_limit: string;
  readonly storage_limit: string;
  readonly public_key: string;
}

export type OperationContent = RevealContent | TransactionContent;

export interface HeadRef {
  readonly hash: string;
  readonly level: number;
  /** `next_protocol`, which is what preapply must be addressed to. */
  readonly protocol: string;
}

export interface PayoutRpc {
  getHead(): Promise<HeadRef>;
  getCounter(address: string): Promise<bigint>;
  getBalance(address: string): Promise<Mutez>;
  /**
   * The account's published public key, or `null` when it never published
   * one. `null` is the whole reason a first payout needs a reveal.
   */
  getManagerKey(address: string): Promise<string | null>;
  /**
   * Dry run against the node. Moves nothing; it is the last chance to see a
   * `backtracked` batch before the money leaves.
   */
  preapply(input: {
    readonly protocol: string;
    readonly branch: string;
    readonly contents: readonly OperationContent[];
    readonly signature: string;
  }): Promise<unknown>;
  injectOperation(signedBytesHex: string): Promise<string>;
}

/**
 * The public key the chain checks this account's signatures against, or
 * `null` when the account has never been revealed.
 *
 * A narrow port for the estimation boundary, which has to hand Taquito a
 * public key and must get it from the chain rather than from the signer —
 * the chain is the only thing that decides whether a signature from this
 * account will be accepted at all.
 *
 * It used to say that no step of the money path reads this. That stopped
 * being true when the injector started revealing the account it is about to
 * spend from (BRES-137), so `PayoutRpc` declares it too and this stays as
 * the smaller port for the side that only ever reads.
 */
export interface ManagerKeySource {
  getManagerKey(address: string): Promise<string | null>;
}

export interface HttpPayoutRpcOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Plain HTTP client for the node. Status is checked before the body is parsed. */
export class HttpPayoutRpc implements PayoutRpc, ManagerKeySource {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly rpcUrl: string,
    options: HttpPayoutRpcOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.rpcUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        signal: controller.signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new HttpError(response.status, url, text);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getHead(): Promise<HeadRef> {
    const [header, protocols] = await Promise.all([
      this.call<{ hash?: string; level?: number }>('/chains/main/blocks/head/header'),
      this.call<{ next_protocol?: string }>('/chains/main/blocks/head/protocols'),
    ]);
    if (!header.hash || typeof header.level !== 'number' || !protocols.next_protocol) {
      throw new HttpError(
        200,
        `${this.rpcUrl}/chains/main/blocks/head`,
        JSON.stringify({ header, protocols }),
      );
    }
    return { hash: header.hash, level: header.level, protocol: protocols.next_protocol };
  }

  async getCounter(address: string): Promise<bigint> {
    const counter = await this.call<string>(
      `/chains/main/blocks/head/context/contracts/${address}/counter`,
    );
    return BigInt(counter);
  }

  async getBalance(address: string): Promise<Mutez> {
    const balance = await this.call<string>(
      `/chains/main/blocks/head/context/contracts/${address}/balance`,
    );
    return BigInt(balance);
  }

  /**
   * `null` is an answer, not a failure: an implicit account that has never
   * been revealed has no manager key, and that is exactly what the caller
   * needs to know. What is refused is anything else — a shape this path does
   * not understand must not collapse into "not revealed", because the two
   * lead to opposite decisions.
   */
  async getManagerKey(address: string): Promise<string | null> {
    const path = `/chains/main/blocks/head/context/contracts/${address}/manager_key`;
    const key = await this.call<unknown>(path);
    if (key === null) return null;
    if (typeof key !== 'string' || key === '') {
      throw new FieldTypeError(
        'manager_key',
        `${this.rpcUrl}${path}`,
        'a base58 public key or null',
        key,
      );
    }
    return key;
  }

  preapply(input: {
    protocol: string;
    branch: string;
    contents: readonly TransactionContent[];
    signature: string;
  }): Promise<unknown> {
    return this.call('/chains/main/blocks/head/helpers/preapply/operations', [
      {
        protocol: input.protocol,
        branch: input.branch,
        contents: input.contents,
        signature: input.signature,
      },
    ]);
  }

  injectOperation(signedBytesHex: string): Promise<string> {
    return this.call<string>('/injection/operation?chain=main', signedBytesHex);
  }
}
