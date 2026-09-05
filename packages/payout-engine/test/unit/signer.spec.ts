import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { b58DecodeAndCheckPrefix, b58Encode, PrefixV2 } from '@taquito/utils';
import { ConfigurationError, HttpError } from '@tezos-suite/chain';
import {
  Ed25519ClientAuthenticator,
  buildAuthenticationPayload,
  encodePublicKeyHash,
} from '../../src/chain/client-auth';
import {
  GENERIC_OPERATION_WATERMARK,
  OctezRemoteSigner,
  assertSignerUrlAllowed,
  loadSignerConfig,
  type SignerRequest,
  type SignerTransport,
} from '../../src/chain/signer';
import { kt1, tz1, tz4 } from '../helpers/addresses';

const CLIENT_AUTH_KEY = b58Encode(Buffer.alloc(32, 9), PrefixV2.Ed25519Seed);

const validEnv = {
  TAPS_SIGNER_URL: 'https://signer.internal:6732',
  TAPS_SIGNER_PKH: tz1(2),
  TAPS_SIGNER_CLIENT_AUTH_KEY: CLIENT_AUTH_KEY,
};

describe('signer configuration', () => {
  it('reads a complete configuration', () => {
    expect(loadSignerConfig(validEnv)).toEqual({
      url: validEnv.TAPS_SIGNER_URL,
      publicKeyHash: validEnv.TAPS_SIGNER_PKH,
      clientAuthKey: CLIENT_AUTH_KEY,
    });
  });

  it.each(Object.keys(validEnv))('refuses to boot without %s', (missing) => {
    const env: Record<string, string> = { ...validEnv };
    delete env[missing];
    expect(() => loadSignerConfig(env)).toThrow(ConfigurationError);
  });

  it('refuses cleartext HTTP', () => {
    expect(() => assertSignerUrlAllowed('http://10.0.0.5:6732')).toThrow(ConfigurationError);
    expect(() => assertSignerUrlAllowed('http://127.0.0.1:6732')).toThrow(ConfigurationError);
    expect(() => assertSignerUrlAllowed('not a url')).toThrow(ConfigurationError);
  });

  it('refuses a unix socket, which octez-signer cannot serve this API over', () => {
    // Verified against octez-signer 25.1: `launch local signer` and
    // `launch socket signer` speak a binary protocol, not this JSON one.
    expect(() => assertSignerUrlAllowed('unix:///run/taps/signer.sock')).toThrow(
      /only over TCP/,
    );
  });

  it('accepts TLS', () => {
    expect(assertSignerUrlAllowed('https://signer.internal:6732').protocol).toBe('https:');
  });
});

describe('no local signing key anywhere in the package', () => {
  /**
   * The custody decision is enforced by a script, not by review. This test is
   * the script's own test: it has to reject a file that reintroduces a local
   * key, or it proves nothing about the files it accepts.
   */
  const sources = (function collect(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) collect(path, out);
      else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
  })(join(__dirname, '..', '..', 'src'));

  const forbidden = [
    /\bInMemorySigner\b/,
    /@taquito\/signer/,
    /\bsetSignerProvider\s*\(/,
    /\bimportKey\s*\(/,
  ];

  it.each(forbidden.map((p) => [p.source, p] as const))(
    'no source file matches %s outside a comment',
    (_label, pattern) => {
      for (const file of sources) {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '');
        expect(code).not.toMatch(pattern);
      }
    },
  );

  it('exports no signer that could hold a key', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exported = require('../../src/index') as Record<string, unknown>;
    const names = Object.keys(exported).filter((name) => /signer/i.test(name));
    expect(names.sort()).toEqual([
      'HttpsSignerTransport',
      'OctezRemoteSigner',
      'assertSignerUrlAllowed',
      'createSignerTransport',
      'loadSignerConfig',
    ]);
  });
});

describe('octez-signer client', () => {
  class RecordingTransport implements SignerTransport {
    readonly calls: { method: string; path: string; body?: string }[] = [];
    constructor(private readonly response: { status: number; body: string }) {}
    async send(method: 'GET' | 'POST', path: string, body?: string) {
      this.calls.push({ method, path, body });
      return this.response;
    }
  }

  const config = loadSignerConfig(validEnv);
  const authenticator = new Ed25519ClientAuthenticator(CLIENT_AUTH_KEY);

  it('authenticates over the key the signature is asked of', async () => {
    const transport = new RecordingTransport({
      status: 200,
      body: JSON.stringify({ signature: 'edsigfake' }),
    });
    const seen: string[] = [];
    const spy = {
      authenticate: async (request: SignerRequest) => {
        seen.push(request.publicKeyHash);
        return 'edsigauth';
      },
    };
    await new OctezRemoteSigner(config, spy, transport).signOperation('6c00');
    expect(seen).toEqual([config.publicKeyHash]);
    expect(transport.calls[0]!.path).toBe(
      `/keys/${config.publicKeyHash}?authentication=edsigauth`,
    );
  });

  it('signs with the generic-operation watermark and nothing else', async () => {
    const transport = new RecordingTransport({
      status: 200,
      body: JSON.stringify({ signature: 'edsigfake' }),
    });
    const signer = new OctezRemoteSigner(config, authenticator, transport);
    await expect(signer.signOperation('6c0011')).resolves.toBe('edsigfake');

    const call = transport.calls[0]!;
    expect(call.path.startsWith(`/keys/${config.publicKeyHash}?authentication=`)).toBe(true);
    expect(JSON.parse(call.body!)).toBe(`${GENERIC_OPERATION_WATERMARK}6c0011`);
  });

  it('raises on a non-2xx instead of parsing the body', async () => {
    const signer = new OctezRemoteSigner(
      config,
      authenticator,
      new RecordingTransport({ status: 403, body: '<html>forbidden</html>' }),
    );
    await expect(signer.signOperation('6c00')).rejects.toBeInstanceOf(HttpError);
  });

  it('raises when the answer carries no signature', async () => {
    const signer = new OctezRemoteSigner(
      config,
      authenticator,
      new RecordingTransport({ status: 200, body: JSON.stringify({ ok: true }) }),
    );
    await expect(signer.signOperation('6c00')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('client authentication', () => {
  /**
   * Captured from `octez-client` 25.1 talking to a real
   * `octez-signer --require-authentication` through a logging proxy. Both keys
   * are throwaway lab keys and hold nothing.
   *
   * This is what pins the layout: change any byte of it and this test fails,
   * so a future change to the payload has to be deliberate.
   */
  const VECTOR = {
    clientSecretKey: 'edsk3W5ouBAVwo65G5fhTTtqAE3fuRx5ifHLiJ2a3HySqkX1YTWAaE',
    publicKeyHash: 'tz1YpNDoR8oURisTtfFgH7pXjCK8eWHJEamL',
    dataHex: `03${'aa'.repeat(40)}`,
    payloadHex:
      '040100908e18c77adc5aae4ad25e20f8a19ec9fa20ffe8' + `03${'aa'.repeat(40)}`,
    signature:
      'edsigtxsHuA6qpJT6FGGHuk5XunrqPkdiQH4MhSumjU1j5x7mzA3Xa4VDpoAW572NSNtYhiWLynyR7ttP7umxRwyvnYMHRf45d7',
  };

  const request = {
    method: 'POST' as const,
    path: `/keys/${VECTOR.publicKeyHash}`,
    publicKeyHash: VECTOR.publicKeyHash,
    dataHex: VECTOR.dataHex,
  };

  it('builds the byte layout octez-signer authenticates over', () => {
    // 0x04 || tag 0x01 || Public_key_hash.to_bytes || data
    expect(buildAuthenticationPayload(request).toString('hex')).toBe(VECTOR.payloadHex);
  });

  it('reproduces a signature octez-client produced', async () => {
    const auth = new Ed25519ClientAuthenticator(VECTOR.clientSecretKey);
    await expect(auth.authenticate(request)).resolves.toBe(VECTOR.signature);
  });

  it('would not reproduce it without the BLAKE2b-256 prehash', async () => {
    // The trap this issue existed to close: the layout alone is not enough,
    // and signing it raw fails silently at the signer, not here.
    const raw = createSign(VECTOR.clientSecretKey, Buffer.from(VECTOR.payloadHex, 'hex'));
    expect(raw).not.toBe(VECTOR.signature);
  });

  it('tags the curve of the address, tz4 included', () => {
    expect(encodePublicKeyHash(tz1(11))[0]).toBe(0x00);
    expect(encodePublicKeyHash(tz4(11))[0]).toBe(0x03);
    expect(encodePublicKeyHash(tz1(11))).toHaveLength(21);
    expect(encodePublicKeyHash(tz4(11))).toHaveLength(21);
  });

  it('refuses an address it cannot encode, instead of signing something else', () => {
    expect(() => encodePublicKeyHash(kt1(3))).toThrow(ConfigurationError);
    expect(() => encodePublicKeyHash('tz1nope')).toThrow(ConfigurationError);
  });

  it('produces a base58 signature and refuses a credential that is not a key', async () => {
    const auth = new Ed25519ClientAuthenticator(CLIENT_AUTH_KEY);
    const signature = await auth.authenticate(request);
    expect(signature.startsWith('edsig')).toBe(true);
    expect(() => new Ed25519ClientAuthenticator('not-a-key')).toThrow(ConfigurationError);
  });
});

/** Signs bytes with no prehash — only to show the prehash is load-bearing. */
function createSign(secretKey: string, payload: Buffer): string {
  const seed = b58DecodeAndCheckPrefix(secretKey, [PrefixV2.Ed25519Seed], true);
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(seed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return b58Encode(nodeSign(null, payload, key), PrefixV2.Ed25519Signature);
}
