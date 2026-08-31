import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The scanners' own tests.
 *
 * A check nobody has seen fail is a check nobody knows works. Each script is
 * run twice: once over a file that breaks its rule, where it must exit 1 and
 * name the token, and once over the package's own source, where it must
 * exit 0.
 */
const SCRIPTS = join(__dirname, '..', '..', 'scripts');
const SRC = join(__dirname, '..', '..', 'src');
const CHAIN_SCRIPTS = join(__dirname, '..', '..', '..', 'tezos-chain', 'scripts');

function run(script: string, target: string): { code: number; output: string } {
  try {
    const stdout = execFileSync('node', [script, target], { encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status: number; stderr: string; stdout: string };
    return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

function fixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'taps-payout-check-'));
  writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}

describe('the money-path scanner', () => {
  const script = join(SCRIPTS, 'check-no-number-money.mjs');

  it('passes over this package', () => {
    expect(run(script, SRC).code).toBe(0);
  });

  it.each([
    ['a monetary field typed as number', 'export interface X { amountMutez: number }'],
    ['float rounding', 'export const to = (t: number) => Math.floor(t * 1000000);'],
    ['1e6 scaling', 'export const to = (t: number) => t * 1e6;'],
    ['parseFloat', 'export const read = (s: string) => parseFloat(s);'],
    ['a value crossing into number', 'export const x = (payableMutez: bigint) => Number(payableMutez);'],
  ])('fails on %s', (_label, code) => {
    const result = run(script, fixture('bad.ts', code));
    expect(result.code).toBe(1);
    expect(result.output).toContain('number found in the money path');
  });

  it('does not object to a count that happens to be a number', () => {
    const good = 'export const batches = (n: number, per: number) => Math.max(1, n);';
    // `Math.max` is not in the rule set; `Math.floor` is. This keeps the check
    // honest about what it claims to catch.
    expect(run(script, fixture('ok.ts', good)).code).toBe(0);
  });
});

describe('the local-key scanner', () => {
  const script = join(SCRIPTS, 'check-no-local-key.mjs');

  it('passes over this package', () => {
    expect(run(script, SRC).code).toBe(0);
  });

  it.each([
    ['an in-process signer', "import { InMemorySigner } from '@taquito/signer';"],
    ['installing a local signer', 'tezos.setSignerProvider(signer);'],
    ['a key in the environment', 'const key = process.env.PAYOUT_PRIVATE_KEY;'],
    ['an unattended signer unlock', 'const args = ["--password-filename", path];'],
  ])('fails on %s', (_label, code) => {
    const result = run(script, fixture('bad.ts', code));
    expect(result.code).toBe(1);
    expect(result.output).toContain('Local signing key material found');
  });
});

describe('the protocol-constants scanner from the chain layer', () => {
  const script = join(CHAIN_SCRIPTS, 'check-no-protocol-constants.mjs');

  it('passes over this package', () => {
    expect(run(script, SRC).code).toBe(0);
  });

  it('still fails on a written-down constant', () => {
    const result = run(script, fixture('bad.ts', 'export const CYCLES_UNTIL_DELIVERED = 5;'));
    expect(result.code).toBe(1);
    expect(result.output).toContain('CYCLES_UNTIL_DELIVERED');
  });
});
