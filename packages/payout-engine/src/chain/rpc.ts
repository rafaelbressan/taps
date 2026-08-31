import { HttpError, type Mutez } from '@tezos-suite/chain';

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
   * Dry run against the node. Moves nothing; it is the last chance to see a
   * `backtracked` batch before the money leaves.
   */
  preapply(input: {
    readonly protocol: string;
    readonly branch: string;
    readonly contents: readonly TransactionContent[];
    readonly signature: string;
  }): Promise<unknown>;
  injectOperation(signedBytesHex: string): Promise<string>;
}

export interface HttpPayoutRpcOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Plain HTTP client for the node. Status is checked before the body is parsed. */
export class HttpPayoutRpc implements PayoutRpc {
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
