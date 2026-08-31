import { HttpError } from '../errors';
import type { NetworkConfig } from '../network';

/**
 * The narrow slice of the Octez RPC the chain layer needs. Kept as an
 * interface so a test can move the protocol hash forward without a network.
 */
export interface RpcSource {
  /** `/chains/main/chain_id` */
  getChainId(): Promise<string>;
  /** `protocol` from `/chains/main/blocks/head/protocols` */
  getProtocolHash(): Promise<string>;
  /** Raw `/chains/main/blocks/head/context/constants`, untouched. */
  getRawConstants(): Promise<Record<string, unknown>>;
  /** `level` from `/chains/main/blocks/head/header` */
  getHeadLevel(): Promise<number>;
}

export interface HttpRpcOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HttpRpcSource implements RpcSource {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly network: NetworkConfig,
    options: HttpRpcOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.network.rpcUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      const body = await response.text();
      // Status first, always. Parsing before checking is how a 429 HTML page
      // becomes "Unexpected token <" and the retry decision is taken on the
      // wrong message.
      if (!response.ok) throw new HttpError(response.status, url, body);
      return JSON.parse(body) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  getChainId(): Promise<string> {
    return this.get<string>('/chains/main/chain_id');
  }

  async getProtocolHash(): Promise<string> {
    const protocols = await this.get<{ protocol?: string }>(
      '/chains/main/blocks/head/protocols',
    );
    if (!protocols.protocol) {
      throw new HttpError(
        200,
        `${this.network.rpcUrl}/chains/main/blocks/head/protocols`,
        JSON.stringify(protocols),
      );
    }
    return protocols.protocol;
  }

  getRawConstants(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(
      '/chains/main/blocks/head/context/constants',
    );
  }

  async getHeadLevel(): Promise<number> {
    const header = await this.get<{ level?: number }>(
      '/chains/main/blocks/head/header',
    );
    if (typeof header.level !== 'number') {
      throw new HttpError(
        200,
        `${this.network.rpcUrl}/chains/main/blocks/head/header`,
        JSON.stringify(header),
      );
    }
    return header.level;
  }
}
