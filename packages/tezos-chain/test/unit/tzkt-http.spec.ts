import { HttpError, RateLimitedError, StaleIndexerError } from '../../src/errors';
import { TzKTHttp } from '../../src/tzkt/http';
import { FRESH_HEADERS, FakeFetch } from '../helpers/fake-fetch';
import { TEST_NETWORK } from '../helpers/network';

/** Exactly what nginx returns on the TzKT free tier: HTML, and no Retry-After. */
const NGINX_429_HTML =
  '<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n' +
  '<body>\r\n<center><h1>429 Too Many Requests</h1></center>\r\n' +
  '<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

const noSleep = async () => {};

describe('TzKT transport', () => {
  it('reports a rate limit, not a JSON syntax error, on the HTML 429 body', async () => {
    // The failure this replaces: JSON.parse of the HTML body throws
    // "Unexpected token <", and the retry decision is taken on that message.
    expect(() => JSON.parse(NGINX_429_HTML)).toThrow(SyntaxError);

    const fake = new FakeFetch(() => ({
      status: 429,
      body: NGINX_429_HTML,
      headers: { 'content-type': 'text/html' },
    }));
    const http = new TzKTHttp(TEST_NETWORK, {
      fetchImpl: fake.fetch,
      maxRetries: 1,
      sleep: noSleep,
    });

    const error = await http.get('/v1/head').catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.status).toBe(429);
    expect(error.message).toContain('429');
    expect(error.message).not.toContain('Unexpected token');
    expect(fake.requests).toHaveLength(2); // one retry, then it gives up
  });

  it('retries a 429 and succeeds when the limit clears', async () => {
    const fake = new FakeFetch((_url, callIndex) =>
      callIndex === 0
        ? { status: 429, body: NGINX_429_HTML, headers: { 'content-type': 'text/html' } }
        : { status: 200, body: '{"level":14727151}', headers: FRESH_HEADERS() },
    );
    const http = new TzKTHttp(TEST_NETWORK, {
      fetchImpl: fake.fetch,
      sleep: noSleep,
    });

    const { body } = await http.get<{ level: number }>('/v1/head');
    expect(body).toEqual({ level: 14727151 });
  });

  it('backs off exponentially with jitter, since there is no Retry-After', () => {
    const http = new TzKTHttp(TEST_NETWORK, {
      baseBackoffMs: 500,
      maxBackoffMs: 30_000,
      random: () => 1,
    });
    expect(http.backoffDelayMs(0)).toBe(500);
    expect(http.backoffDelayMs(1)).toBe(1000);
    expect(http.backoffDelayMs(2)).toBe(2000);
    expect(http.backoffDelayMs(10)).toBe(30_000); // capped

    const jittered = new TzKTHttp(TEST_NETWORK, {
      baseBackoffMs: 500,
      random: () => 0.25,
    });
    expect(jittered.backoffDelayMs(2)).toBe(500);
  });

  it('treats 204 with an empty body as "unknown", not as an error', async () => {
    const fake = new FakeFetch(() => ({ status: 204, headers: FRESH_HEADERS() }));
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch });

    // TzKT answers 204 for an operation hash it has never seen. It is not 404,
    // and it is not "not paid".
    const { body } = await http.get('/v1/operations/opUnknown/status');
    expect(body).toBeUndefined();
  });

  it('surfaces a 400 with its body instead of parsing it', async () => {
    const fake = new FakeFetch(() => ({
      status: 400,
      body: '{"errors":{"limit":["The field limit must be between 0 and 10000."]}}',
    }));
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch });

    const error = await http.get('/v1/rewards/split/tz1x/1336').catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(400);
    expect(error.message).toContain('between 0 and 10000');
  });

  it('refuses data from an indexer that is behind', async () => {
    const fake = new FakeFetch(() => ({
      status: 200,
      body: '{"level":14727000}',
      headers: { ...FRESH_HEADERS(), 'tzkt-level': '14727000', 'tzkt-known-level': '14727151' },
    }));
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch, maxLagBlocks: 2 });

    // A lagging indexer answers 200 with stale data. Nothing in the body says so.
    const error = await http.get('/v1/head').catch((e) => e);
    expect(error).toBeInstanceOf(StaleIndexerError);
    expect(error.message).toContain('151 blocks behind');
  });

  it('accepts a small lag when the caller allows one', async () => {
    const fake = new FakeFetch(() => ({
      status: 200,
      body: '{"level":14727150}',
      headers: { ...FRESH_HEADERS(), 'tzkt-level': '14727150', 'tzkt-known-level': '14727151' },
    }));
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch, maxLagBlocks: 2 });
    const { body, freshness } = await http.get<{ level: number }>('/v1/head');
    expect(body).toEqual({ level: 14727150 });
    expect(freshness?.syncedAt?.toISOString()).toBe('2026-08-30T13:00:20.000Z');
  });

  it('never runs more requests in parallel than the configured concurrency', async () => {
    const fake = new FakeFetch(() => ({
      status: 200,
      body: '[]',
      headers: FRESH_HEADERS(),
    }));
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch, concurrency: 3 });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => http.get(`/v1/accounts/tz1x${index}`)),
    );
    expect(fake.maxConcurrentObserved).toBeLessThanOrEqual(3);
    expect(fake.requests).toHaveLength(20);
  });

  it('clamps concurrency into the measured safe range', async () => {
    const fake = new FakeFetch(() => ({ status: 200, body: '[]', headers: FRESH_HEADERS() }));
    // 30 parallel requests measured 35 of 60 as 429. The client refuses to try.
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch, concurrency: 30 });
    await Promise.all(Array.from({ length: 12 }, () => http.get('/v1/head')));
    expect(fake.maxConcurrentObserved).toBeLessThanOrEqual(4);
  });
});
