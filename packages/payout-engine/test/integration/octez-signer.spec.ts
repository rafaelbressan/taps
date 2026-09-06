import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519ClientAuthenticator } from '../../src/chain/client-auth';
import {
  OctezRemoteSigner,
  type SignerConfig,
  type SignerTransport,
} from '../../src/chain/signer';

/**
 * Client authentication, against the real binary.
 *
 * A mock cannot prove this. The whole point of BRES-74 is that a payload can
 * be wrong while every unit test agrees with it: the only authority on what
 * `octez-signer --require-authentication` accepts is `octez-signer` itself.
 *
 * Runs over cleartext HTTP on loopback with throwaway keys — that is a lab,
 * not a deployment. The production path is `launch https signer <cert> <key>`
 * and the client refuses anything else (see `assertSignerUrlAllowed`).
 *
 *   npm run test:signer
 */

const IMAGE = process.env.OCTEZ_IMAGE ?? 'tezos/tezos:octez-v25.1';
const CONTAINER = 'taps-signer-auth-test';
const PORT = Number(process.env.OCTEZ_SIGNER_TEST_PORT ?? 21732);

function docker(args: string[], timeoutMs = 180_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
}

function dockerAvailable(): boolean {
  try {
    docker(['info', '--format', '{{.ServerVersion}}'], 20_000);
    return true;
  } catch {
    return false;
  }
}

function signerCli(dataDir: string, args: string[]): string {
  return docker([
    'run',
    '--rm',
    '-u',
    `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    '-v',
    `${dataDir}:/data`,
    '--entrypoint',
    'octez-signer',
    IMAGE,
    '-d',
    '/data',
    ...args,
  ]);
}

/** The wallet files are `[{ "name": …, "value": … }]`, value prefixed by scheme. */
function walletValue(dir: string, file: string, name: string): string {
  const entries = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    name: string;
    value: string;
  }[];
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no ${name} in ${file}`);
  return entry.value.replace(/^unencrypted:/, '');
}

/** Cleartext transport. Lab only — the product refuses non-TLS URLs. */
class LoopbackTransport implements SignerTransport {
  constructor(private readonly baseUrl: string) {}
  async send(method: 'GET' | 'POST', path: string, body?: string) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body,
    });
    return { status: response.status, body: await response.text() };
  }
}

const available = dockerAvailable();
const describeWithDocker = available ? describe : describe.skip;
if (!available) {
  // Not a silent pass: the reason is on the record.
  console.warn(
    'octez-signer integration test skipped: docker is not reachable from this host',
  );
}

describeWithDocker('octez-signer --require-authentication', () => {
  let root: string;
  let payoutPkh: string;
  let authorizedKey: string;
  let strangerKey: string;
  let transport: SignerTransport;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'taps-signer-'));
    const signerDir = join(root, 'signer');
    const clientDir = join(root, 'client');
    const strangerDir = join(root, 'stranger');
    for (const dir of [signerDir, clientDir, strangerDir]) {
      execFileSync('mkdir', ['-p', dir]);
    }

    signerCli(signerDir, ['gen', 'keys', 'payout']);
    signerCli(clientDir, ['gen', 'keys', 'client']);
    signerCli(strangerDir, ['gen', 'keys', 'stranger']);

    payoutPkh = walletValue(signerDir, 'public_key_hashs', 'payout');
    authorizedKey = walletValue(clientDir, 'secret_keys', 'client');
    strangerKey = walletValue(strangerDir, 'secret_keys', 'stranger');

    signerCli(signerDir, [
      'add',
      'authorized',
      'key',
      walletValue(clientDir, 'public_keys', 'client'),
    ]);

    try {
      docker(['rm', '-f', CONTAINER], 30_000);
    } catch {
      // no leftover container from an earlier run
    }
    docker([
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-u',
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '-p',
      `127.0.0.1:${PORT}:6732`,
      '-v',
      `${signerDir}:/data`,
      '--entrypoint',
      'octez-signer',
      IMAGE,
      '-d',
      '/data',
      '--require-authentication',
      'launch',
      'http',
      'signer',
      '--address',
      '0.0.0.0',
      '--port',
      '6732',
      '--magic-bytes',
      '0x03',
    ]);

    transport = new LoopbackTransport(`http://127.0.0.1:${PORT}`);
  }, 300_000);

  afterAll(() => {
    try {
      docker(['rm', '-f', CONTAINER], 30_000);
    } catch {
      // already gone
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function waitForSigner(): Promise<void> {
    // The published port answers before the daemon binds, and resets the
    // connection until it does — a refused connection here is "not yet".
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const { status } = await transport.send('GET', '/authorized_keys');
        if (status === 200) return;
      } catch {
        // still coming up
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `octez-signer did not come up on ${PORT}: ${docker(['logs', CONTAINER], 20_000)}`,
    );
  }

  function signerWith(clientAuthKey: string): OctezRemoteSigner {
    const config: SignerConfig = {
      url: `http://127.0.0.1:${PORT}`,
      publicKeyHash: payoutPkh,
      clientAuthKey,
    };
    return new OctezRemoteSigner(
      config,
      new Ed25519ClientAuthenticator(clientAuthKey),
      transport,
    );
  }

  it('accepts the authorized client key', async () => {
    await waitForSigner();
    const signature = await signerWith(authorizedKey).signOperation('6c00'.padEnd(80, 'ab'));
    expect(signature).toMatch(/^(edsig|sig)/);
  });

  it('refuses a key it was never told about', async () => {
    // The check has to be able to fail. Without this, "accepted" proves
    // nothing: a signer that accepts everything would pass the test above.
    await waitForSigner();
    await expect(
      signerWith(strangerKey).signOperation('6c00'.padEnd(80, 'ab')),
    ).rejects.toThrow(/invalid authentication signature/);
  });
});
