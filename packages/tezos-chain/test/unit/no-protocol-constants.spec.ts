import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGE_ROOT = resolve(__dirname, '../..');
const CHECKER = join(PACKAGE_ROOT, 'scripts/check-no-protocol-constants.mjs');

function runChecker(target: string): { code: number; output: string } {
  try {
    const output = execFileSync('node', [CHECKER, target], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('no protocol constants in source', () => {
  it('passes on this package', () => {
    const { code, output } = runChecker(join(PACKAGE_ROOT, 'src'));
    expect(output).toMatch(/No protocol constants in \d+ source file/);
    expect(code).toBe(0);
  });

  it('fails on code that writes a protocol constant down', () => {
    // A check that cannot fail is not a check. This is the shape of the code
    // the rule exists to stop, including the exact pre-2020 value.
    const directory = mkdtempSync(join(tmpdir(), 'chain-constants-'));
    const file = join(directory, 'frozen.ts');
    writeFileSync(
      file,
      [
        'export const TEZOS_CONSTANTS = {',
        '  BLOCKS_PER_CYCLE: 4096,',
        '  DEFAULT_GAS_LIMIT: 15400,',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const { code, output } = runChecker(file);
    expect(code).toBe(1);
    expect(output).toContain('BLOCKS_PER_CYCLE');
    expect(output).toContain('4096');
    expect(output).toContain('15400');
    expect(output).toContain('/chains/main/blocks/head/context/constants');
  });
});
