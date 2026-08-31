import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { b58Encode, PrefixV2 } from '@taquito/utils';
import { ConfigurationError, HttpError } from '@tezos-suite/chain';
import { Ed25519ClientAuthenticator, buildAuthenticationPayload } from '../../src/chain/client-auth';
import {
  GENERIC_OPERATION_WATERMARK,
  OctezRemoteSigner,
  assertSignerUrlAllowed,
  loadSignerConfig,
  type SignerTransport,
} from '../../src/chain/signer';
import { tz1 } from '../helpers/addresses';

const CLIENT_AUTH_KEY = b58Encode(Buffer.alloc(32, 9), PrefixV2.Ed25519Seed);

const validEnv = {
  TAPS_SIGNER_URL: 'unix:///run/taps/signer.sock',
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

  it('accepts a unix socket and TLS', () => {
    expect(assertSignerUrlAllowed('unix:///run/taps/signer.sock').protocol).toBe('unix:');
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
      'UnixSocketSignerTransport',
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
  it('signs the pinned payload layout', async () => {
    const request = { method: 'POST' as const, path: '/keys/tz1x', dataHex: '0300ff' };
    const payload = buildAuthenticationPayload(request);
    expect(payload.subarray(0, 1)).toEqual(Buffer.from([0x04]));
    expect(payload.subarray(1, 1 + request.path.length).toString()).toBe(request.path);
    expect(payload.subarray(1 + request.path.length).toString('hex')).toBe('0300ff');
  });

  it('produces a base58 signature and refuses a credential that is not a key', async () => {
    const auth = new Ed25519ClientAuthenticator(CLIENT_AUTH_KEY);
    const signature = await auth.authenticate({ method: 'POST', path: '/keys/x' });
    expect(signature.startsWith('edsig')).toBe(true);
    expect(() => new Ed25519ClientAuthenticator('not-a-key')).toThrow(ConfigurationError);
  });
});
