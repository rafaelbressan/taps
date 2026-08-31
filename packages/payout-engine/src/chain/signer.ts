import { request as httpRequest } from 'node:http';
import { ConfigurationError, HttpError } from '@tezos-suite/chain';

/**
 * Signing.
 *
 * Custody decision of 2026-08-28 (option A): the TAPS backend does not store,
 * derive or carry the payout key. No database column, no file, no environment
 * variable. Every signature comes from an `octez-signer` on a separate host.
 *
 * There is deliberately no local-key signer in this package, not even a
 * "degraded mode". A fallback that signs locally when the signer is
 * unreachable is the same defect the decision removes, reintroduced at the
 * moment the operator is least able to notice.
 */

export interface PayoutSigner {
  /** The address the operations are sourced from. */
  publicKeyHash(): Promise<string>;
  /**
   * Signs the generic-operation watermark (`0x03`) followed by the forged
   * bytes, and returns the base58 signature. `--magic-bytes 0x03` on the
   * signer refuses block headers and attestations, so this is the only kind
   * of signature the payout host can ever obtain.
   */
  signOperation(forgedBytesHex: string): Promise<string>;
}

/** Generic operation. The only watermark the payout path ever uses. */
export const GENERIC_OPERATION_WATERMARK = '03';

export interface SignerConfig {
  /** `https://…` or `unix:///path/to/socket`. Plain HTTP is refused. */
  readonly url: string;
  /** The payout key's public key hash, as known to the signer. */
  readonly publicKeyHash: string;
  /**
   * The CLIENT credential, base58 `edsk…`. This is the key the signer's
   * `--require-authentication` checks; it is NOT the key that holds the
   * funds, and possessing it moves no money on its own.
   */
  readonly clientAuthKey: string;
}

const SIGNER_URL_ENV = 'TAPS_SIGNER_URL';
const SIGNER_PKH_ENV = 'TAPS_SIGNER_PKH';
const SIGNER_AUTH_ENV = 'TAPS_SIGNER_CLIENT_AUTH_KEY';

function requireEnv(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new ConfigurationError(`${name} is not set — ${why}`);
  }
  return value.trim();
}

/**
 * Refuses plain HTTP.
 *
 * The signer speaks a protocol where the request body is the exact bytes that
 * will move money. Over cleartext HTTP anyone on the path can substitute
 * them, and the signer will sign what it is given.
 */
export function assertSignerUrlAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError(
      `${SIGNER_URL_ENV} is not a URL: ${JSON.stringify(url)}`,
    );
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'unix:') return parsed;
  throw new ConfigurationError(
    `${SIGNER_URL_ENV} uses ${parsed.protocol} — the signer is reachable over a unix ` +
      'socket (unix:///path) or TLS (https://), never cleartext HTTP',
  );
}

/**
 * Reads the signer endpoint from the environment.
 *
 * All three variables are required and none has a default. A missing one
 * stops the process: the alternative is a payout host that boots, finds no
 * signer, and reaches for something else.
 */
export function loadSignerConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  const url = requireEnv(
    env,
    SIGNER_URL_ENV,
    'every signature comes from a remote octez-signer and there is no local key to fall back to',
  );
  assertSignerUrlAllowed(url);
  return {
    url,
    publicKeyHash: requireEnv(
      env,
      SIGNER_PKH_ENV,
      'the payout address must be named explicitly, never discovered',
    ),
    clientAuthKey: requireEnv(
      env,
      SIGNER_AUTH_ENV,
      'the signer runs with --require-authentication and this is the client credential',
    ),
  };
}

export interface SignerRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** Hex of the watermarked bytes, for a signing request. */
  readonly dataHex?: string;
}

/**
 * Produces the `authentication=` query parameter the signer checks against
 * its `authorized key` list.
 *
 * It is a port with no default binding on purpose: the exact byte layout the
 * signer authenticates over must be confirmed against the signer host in use,
 * and a wrong guess here fails closed at deploy time rather than quietly.
 */
export interface SignerAuthenticator {
  authenticate(request: SignerRequest): Promise<string>;
}

export interface SignerTransport {
  send(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
  ): Promise<{ status: number; body: string }>;
}

/** TLS endpoint. Uses the platform fetch, no client-side redirect following. */
export class HttpsSignerTransport implements SignerTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(method: 'GET' | 'POST', path: string, body?: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body,
      });
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Unix socket endpoint, which is what owner-only permissions protect. */
export class UnixSocketSignerTransport implements SignerTransport {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 15_000,
  ) {}

  send(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          timeout: this.timeoutMs,
          headers:
            body === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(body),
                },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error('signer socket timed out')));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

export function createSignerTransport(config: SignerConfig): SignerTransport {
  const parsed = assertSignerUrlAllowed(config.url);
  if (parsed.protocol === 'unix:') {
    return new UnixSocketSignerTransport(decodeURIComponent(parsed.pathname));
  }
  return new HttpsSignerTransport(config.url.replace(/\/+$/, ''));
}

/**
 * Client for `octez-signer`.
 *
 * The signer is expected to be started with, explicitly, all of:
 *   --magic-bytes 0x03            only generic operations
 *   --require-authentication      plus `add authorized key <pk>`
 *   a unix socket with owner-only permissions, or TLS
 * and WITHOUT `--allow-list-known-keys`, `--allow-to-prove-possession` or
 * `--password-filename` — the last one recreates, on the signer host, the
 * very defect the custody decision removes. Unlocking is interactive at
 * daemon start: one human action per restart, never one per payout cycle.
 */
export class OctezRemoteSigner implements PayoutSigner {
  constructor(
    private readonly config: SignerConfig,
    private readonly authenticator: SignerAuthenticator,
    private readonly transport: SignerTransport = createSignerTransport(config),
  ) {}

  async publicKeyHash(): Promise<string> {
    return this.config.publicKeyHash;
  }

  async signOperation(forgedBytesHex: string): Promise<string> {
    const dataHex = `${GENERIC_OPERATION_WATERMARK}${stripHex(forgedBytesHex)}`;
    const path = `/keys/${this.config.publicKeyHash}`;
    const authentication = await this.authenticator.authenticate({
      method: 'POST',
      path,
      dataHex,
    });
    const url = `${path}?authentication=${encodeURIComponent(authentication)}`;

    const response = await this.transport.send('POST', url, JSON.stringify(dataHex));
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(response.status, `${this.config.url}${path}`, response.body);
    }

    const parsed = JSON.parse(response.body) as { signature?: unknown };
    if (typeof parsed.signature !== 'string' || parsed.signature === '') {
      throw new HttpError(
        response.status,
        `${this.config.url}${path}`,
        `signer answered without a "signature" field: ${response.body.slice(0, 200)}`,
      );
    }
    return parsed.signature;
  }
}

function stripHex(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}
