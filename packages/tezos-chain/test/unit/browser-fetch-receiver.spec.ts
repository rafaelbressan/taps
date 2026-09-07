import { HttpRpcSource } from '../../src/rpc/rpc-source';
import { TzKTHttp } from '../../src/tzkt/http';
import { FRESH_HEADERS, FakeFetch } from '../helpers/fake-fetch';
import { TEST_NETWORK } from '../helpers/network';

/**
 * The browser refuses `fetch` called as a method of another object. Both
 * clients here stored it in a property and called `this.fetchImpl(url)`, so
 * every chain read from a browser died with "Illegal invocation" — balance,
 * constants, head, send.
 *
 * Nothing caught it: undici's `fetch` (Node, and jsdom on top of it) does not
 * check the receiver, so the whole suite stayed green over a client that could
 * not read the chain at all. These tests put the browser's rule in front of
 * the global `fetch`, inside Node.
 */
function browserRuleFetch(
  routes: Record<string, { body: unknown; headers?: Record<string, string> }>,
): typeof fetch {
  const impl = function (this: unknown, input: unknown): Promise<Response> {
    // Exactly what Chromium enforces: the receiver must be the global object.
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    const url = String(input);
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (!route) return Promise.resolve(new Response('no route', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: 200,
        headers: { 'content-type': 'application/json', ...route.headers },
      }),
    );
  };
  return impl as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the default fetch, under the browser receiver rule', () => {
  it('reads TzKT without "Illegal invocation"', async () => {
    globalThis.fetch = browserRuleFetch({
      '/v1/head': { body: { level: 14727151 }, headers: FRESH_HEADERS() },
    });
    const http = new TzKTHttp(TEST_NETWORK);

    const { body } = await http.get<{ level: number }>('/v1/head');
    expect(body).toEqual({ level: 14727151 });
  });

  it('reads the node RPC without "Illegal invocation"', async () => {
    globalThis.fetch = browserRuleFetch({
      '/chains/main/blocks/head/header': { body: { level: 14727151 } },
    });
    const rpc = new HttpRpcSource(TEST_NETWORK);

    await expect(rpc.getHeadLevel()).resolves.toBe(14727151);
  });

  it('still uses an injected fetchImpl, untouched', async () => {
    globalThis.fetch = (() => {
      throw new Error('the injected fetchImpl was ignored');
    }) as unknown as typeof fetch;
    const fake = new FakeFetch(() => ({
      status: 200,
      body: '{"level":14727151}',
      headers: FRESH_HEADERS(),
    }));
    const http = new TzKTHttp(TEST_NETWORK, { fetchImpl: fake.fetch });

    const { body } = await http.get<{ level: number }>('/v1/head');
    expect(body).toEqual({ level: 14727151 });
    expect(fake.requests).toHaveLength(1);
  });
});
