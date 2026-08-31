/** A `fetch` stand-in that answers from a scripted table of routes. */
export interface FakeResponseSpec {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

export interface RecordedRequest {
  readonly url: string;
  readonly at: number;
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private sequence: number = 0;
  private inFlight = 0;
  maxConcurrentObserved = 0;

  constructor(
    private readonly handler: (
      url: string,
      callIndex: number,
    ) => FakeResponseSpec | Promise<FakeResponseSpec>,
  ) {}

  readonly fetch: typeof fetch = (async (input: unknown) => {
    const url = String(input);
    const callIndex = this.sequence;
    this.sequence += 1;
    this.requests.push({ url, at: callIndex });

    this.inFlight += 1;
    this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.inFlight);
    try {
      // Yield once so overlapping calls are actually observable.
      await Promise.resolve();
      const spec = await this.handler(url, callIndex);
      const status = spec.status ?? 200;
      const headers = new Headers(spec.headers ?? {});
      const body = status === 204 ? null : (spec.body ?? '');
      return new Response(body, { status, headers });
    } finally {
      this.inFlight -= 1;
    }
  }) as typeof fetch;
}

export const FRESH_HEADERS = (level = 14_727_151) => ({
  'tzkt-version': '1.17.3.0',
  'tzkt-level': String(level),
  'tzkt-known-level': String(level),
  'tzkt-synced-at': '2026-08-30T13:00:20Z',
  'content-type': 'application/json',
});
