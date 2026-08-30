import { HttpError, RateLimitedError, StaleIndexerError } from '../errors';
import type { NetworkConfig } from '../network';

export interface TzKTFreshness {
  /** `tzkt-level` — the level the indexer has processed. */
  readonly level: number;
  /** `tzkt-known-level` — the level the indexer knows the node is at. */
  readonly knownLevel: number;
  /** `tzkt-synced-at`, when present. */
  readonly syncedAt?: Date;
}

export interface TzKTResponse<T> {
  readonly body: T;
  readonly freshness?: TzKTFreshness;
}

export interface TzKTHttpOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** 1–4. TzKT answers 429 from nginx well below 30 parallel requests. */
  readonly concurrency?: number;
  readonly maxRetries?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Injected so the backoff test is deterministic. */
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Refuse data from an indexer more than this many blocks behind the node.
   * `undefined` disables the check; 0 means "must be fully caught up".
   */
  readonly maxLagBlocks?: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function parseFreshness(headers: Headers): TzKTFreshness | undefined {
  const level = Number(headers.get('tzkt-level'));
  const knownLevel = Number(headers.get('tzkt-known-level'));
  if (!Number.isFinite(level) || !Number.isFinite(knownLevel)) return undefined;
  const syncedAtRaw = headers.get('tzkt-synced-at');
  const syncedAt = syncedAtRaw ? new Date(syncedAtRaw) : undefined;
  return syncedAt && !Number.isNaN(syncedAt.getTime())
    ? { level, knownLevel, syncedAt }
    : { level, knownLevel };
}

/**
 * TzKT client transport.
 *
 * Two behaviours here exist because of measured facts, not caution:
 *
 * 1. The status is checked before the body is parsed. A 429 arrives from
 *    nginx as `text/html`, so an unconditional `JSON.parse` fails with a
 *    syntax error and the retry decision gets taken on the wrong message.
 * 2. There is no `Retry-After` header on that 429 and no quota header, so
 *    the backoff is exponential with jitter, decided entirely client-side.
 */
export class TzKTHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxLagBlocks?: number;

  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly network: NetworkConfig,
    options: TzKTHttpOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.concurrency = Math.min(4, Math.max(1, options.concurrency ?? 2));
    this.maxRetries = options.maxRetries ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxLagBlocks = options.maxLagBlocks;
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  backoffDelayMs(attempt: number): number {
    const exponential = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** attempt,
    );
    // Full jitter: without it, every worker retries on the same tick and
    // reproduces the burst that produced the 429 in the first place.
    return Math.floor(exponential * this.random());
  }

  /**
   * Returns `undefined` for HTTP 204. TzKT answers 204 with an empty body for
   * an operation hash it has never seen — that is "unknown", not an error,
   * and not "not paid". It is also what breaks an unconditional JSON.parse.
   */
  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<
    TzKTResponse<T | undefined>
  > {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) search.set(key, String(value));
    const suffix = search.toString() ? `?${search}` : '';
    const url = `${this.network.tzktApiUrl}${path}${suffix}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.withSlot(() => this.attempt<T>(url));
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof HttpError && RETRYABLE_STATUS.has(error.status);
        if (!retryable || attempt === this.maxRetries) throw error;
        await this.sleep(this.backoffDelayMs(attempt));
      }
    }
    throw lastError;
  }

  private async attempt<T>(url: string): Promise<TzKTResponse<T | undefined>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const freshness = parseFreshness(response.headers);

      if (response.status === 429) {
        // Body is HTML from nginx. Read it as text, never as JSON.
        throw new RateLimitedError(url, await response.text());
      }
      if (!response.ok) {
        throw new HttpError(response.status, url, await response.text());
      }
      if (response.status === 204) {
        return freshness ? { body: undefined, freshness } : { body: undefined };
      }

      const text = await response.text();
      if (text.trim() === '') {
        return freshness ? { body: undefined, freshness } : { body: undefined };
      }

      this.assertFresh(freshness);
      const body = JSON.parse(text) as T;
      return freshness ? { body, freshness } : { body };
    } finally {
      clearTimeout(timer);
    }
  }

  private assertFresh(freshness: TzKTFreshness | undefined): void {
    if (this.maxLagBlocks === undefined || freshness === undefined) return;
    const lag = freshness.knownLevel - freshness.level;
    if (lag > this.maxLagBlocks) {
      throw new StaleIndexerError(
        freshness.level,
        freshness.knownLevel,
        this.maxLagBlocks,
      );
    }
  }

  /** Same as `get`, but a 204 / empty body is a missing resource. */
  async getRequired<T>(
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<TzKTResponse<T>> {
    const response = await this.get<T>(path, query);
    if (response.body === undefined) {
      throw new HttpError(204, `${this.network.tzktApiUrl}${path}`, '(empty body)');
    }
    return response as TzKTResponse<T>;
  }
}
