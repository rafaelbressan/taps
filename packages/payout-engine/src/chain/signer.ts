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
  /**
   * `https://…`. Verified against Octez 25.1: the signer serves this JSON API
   * on `launch http signer` and `launch https signer`, both TCP only. There is
   * NO mode that serves it over a unix socket — `launch local signer` and
   * `launch socket signer` speak a different, binary protocol — so a
   * `unix://` endpoint here could never work and is refused.
   */
  readonly url: string;
  /** The payout key's public key hash, as known to the signer. */
  readonly publicKeyHash: string;
  /**
   * The CLIENT credential, base58 `edsk…`, for a signer started with
   * `--require-authentication`. It is NOT the key that holds the funds and
   * moves no money on its own.
   *
   * Optional because this client cannot yet satisfy that check — see
   * `client-auth.ts`. Against a signer without `--require-authentication` it
   * is not needed at all.
   */
  readonly clientAuthKey?: string;
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
 * Only TLS.
 *
 * The request body is the exact byte string that will move money. Over
 * cleartext HTTP anyone on the path can substitute it and the signer will
 * sign what it is handed.
 *
 * `unix://` is refused too, and not for security: `octez-signer` has no mode
 * that serves this JSON API over a unix socket. Accepting the scheme would
 * only let a deployment fail at the first signature instead of at boot.
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
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'unix:') {
    throw new ConfigurationError(
      `${SIGNER_URL_ENV} is a unix socket, and octez-signer serves this JSON API only ` +
        'over TCP — use `launch https signer <cert> <key>` and an https:// URL',
    );
  }
  throw new ConfigurationError(
    `${SIGNER_URL_ENV} uses ${parsed.protocol} — the signer must be reached over TLS ` +
      '(https://), never cleartext HTTP',
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
  const clientAuthKey = env[SIGNER_AUTH_ENV]?.trim();
  return {
    url,
    publicKeyHash: requireEnv(
      env,
      SIGNER_PKH_ENV,
      'the payout address must be named explicitly, never discovered',
    ),
    ...(clientAuthKey ? { clientAuthKey } : {}),
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

export function createSignerTransport(config: SignerConfig): SignerTransport {
  assertSignerUrlAllowed(config.url);
  return new HttpsSignerTransport(config.url.replace(/\/+$/, ''));
}

/**
 * Client for `octez-signer`.
 *
 * The signer is expected to be started with, explicitly:
 *   launch https signer <cert> <key>   TLS; the JSON API is TCP only
 *   --magic-bytes 0x03                 only generic operations
 * and WITHOUT `--allow-list-known-keys`, `--allow-to-prove-possession` or
 * `--password-filename` — the last one recreates, on the signer host, the
 * very defect the custody decision removes. Unlocking is interactive at
 * daemon start: one human action per restart, never one per payout cycle.
 */
export class OctezRemoteSigner implements PayoutSigner {
  constructor(
    private readonly config: SignerConfig,
    /**
     * Only for a signer started with `--require-authentication`. Omit it and
     * no `authentication` parameter is sent, which is what a signer without
     * that flag expects.
     */
    private readonly authenticator: SignerAuthenticator | undefined,
    private readonly transport: SignerTransport = createSignerTransport(config),
  ) {}

  async publicKeyHash(): Promise<string> {
    return this.config.publicKeyHash;
  }

  async signOperation(forgedBytesHex: string): Promise<string> {
    const dataHex = `${GENERIC_OPERATION_WATERMARK}${stripHex(forgedBytesHex)}`;
    const path = `/keys/${this.config.publicKeyHash}`;
    const authentication = await this.authenticator?.authenticate({
      method: 'POST',
      path,
      dataHex,
    });
    const url =
      authentication === undefined
        ? path
        : `${path}?authentication=${encodeURIComponent(authentication)}`;

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
