/**
 * Cliente HTTP com as regras que o levantamento de rede (BRES-38) exige.
 *
 * Três armadilhas medidas na TzKT real e tratadas aqui:
 *   - 429 vem do nginx com corpo **HTML** e sem `Retry-After`  → cheque status antes de parsear.
 *   - 204 significa "operação desconhecida", com **corpo vazio** → não é erro e não é `false`.
 *   - Sem header de quota → backoff exponencial com jitter, no cliente.
 */

export interface HttpResult<T> {
  status: number;
  headers: Headers;
  /** `undefined` quando o corpo é vazio (204). */
  body: T | undefined;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly snippet: string,
  ) {
    super(`HTTP ${status} em ${url}: ${snippet}`);
    this.name = 'HttpError';
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export interface FetchOptions {
  timeoutMs: number;
  maxAttempts?: number;
  method?: string;
  body?: unknown;
}

/** GET/POST com backoff exponencial + jitter. Nunca faz `JSON.parse` cego. */
export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<HttpResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 5;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const init: RequestInit = { method: opts.method ?? 'GET', signal: ac.signal };
      if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
        init.headers = { 'content-type': 'application/json' };
      }
      const res = await fetch(url, init);

      // 204: corpo vazio, semanticamente "não sei". Não parseie.
      if (res.status === 204) {
        return { status: 204, headers: res.headers, body: undefined };
      }

      const text = await res.text();

      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new HttpError(res.status, url, text.slice(0, 200));
      }

      if (text.length === 0) {
        return { status: res.status, headers: res.headers, body: undefined };
      }
      return { status: res.status, headers: res.headers, body: JSON.parse(text) as T };
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`falha ao chamar ${url}: ${String(lastErr)}`);
}

function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * base * 0.5); // jitter
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Executa `jobs` com concorrência limitada, preservando a ordem do resultado. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
