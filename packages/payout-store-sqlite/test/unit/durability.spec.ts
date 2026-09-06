import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sumMutez } from '@tezos-suite/chain';
import { buildHarness } from '../../../payout-engine/test/helpers/engine';
import { FakeChain } from '../../../payout-engine/test/helpers/fake-chain';
import { delegator, makeSplit } from '../../../payout-engine/test/helpers/split';
import { tz1 } from '../../../payout-engine/test/helpers/addresses';
import { openPayoutDatabase } from '../../src/open';
import type { OpenedDatabase } from '../../src/open';

/**
 * The durability half of the idempotency claim, on the store that ships.
 *
 * `FilePayoutStore` already proves the engine resumes from a file. This proves
 * the same thing through SQLite — a different implementation of the same port,
 * with the constraint enforced by the database rather than by a Map — because
 * "the second run injects nothing" has to be a property of what the baker's
 * machine actually runs.
 *
 * Each "process" here is a fresh `openPayoutDatabase` over the same file: a new
 * connection, a new store object, nothing shared but the bytes on disk.
 */
describe('the state survives the process that wrote it', () => {
  const BAKER = tz1(1);
  const CYCLE = 1336;
  const ALICE = tz1(201);
  const BOB = tz1(202);

  const split = makeSplit({
    baker: BAKER,
    cycle: CYCLE,
    ownDelegatedBalance: 1_000_000_000n,
    delegatedRewards: 28_057_420n,
    delegators: [delegator(ALICE, 4_000_000_000n), delegator(BOB, 6_000_000_000n)],
  });

  let directory: string;
  const open = new Set<OpenedDatabase>();

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'taps-sqlite-store-'));
  });
  afterEach(async () => {
    for (const opened of open) await opened.db.close();
    open.clear();
    rmSync(directory, { recursive: true, force: true });
  });

  async function process_(): Promise<OpenedDatabase> {
    const opened = await openPayoutDatabase(join(directory, 'taps.db'));
    open.add(opened);
    return opened;
  }

  it('resumes from the database without paying again after the answer is lost', async () => {
    const chain = new FakeChain();

    const first = await process_();
    const firstRun = buildHarness({ split, chain, store: first.store });
    chain.landThenFailNextInjection = true;
    await expect(firstRun.engine.run(firstRun.request)).rejects.toThrow(/connection reset/);
    await first.db.close();
    open.delete(first);

    // Second process. A new connection over the same file, sharing nothing
    // with the first but the bytes on disk.
    const second = await process_();
    const recorded = (await second.store.getDistribution(BAKER, CYCLE))!.batches[0]!.opHash!;
    expect(chain.injected.has(recorded)).toBe(true);

    const resumed = buildHarness({ split, chain, store: second.store });
    const result = await resumed.engine.run(resumed.request);

    expect(result.status).toBe('settled');
    expect(result.injected).toEqual([]);
    expect(result.skipped).toEqual([recorded]);
    expect(chain.injected.size).toBe(1);
    expect(resumed.signer.signed).toHaveLength(0);
  });

  it('keeps a second run of a settled cycle from injecting anything', async () => {
    const chain = new FakeChain();

    const first = await process_();
    const settled = await (async () => {
      const harness = buildHarness({ split, chain, store: first.store });
      return harness.engine.run(harness.request);
    })();
    expect(settled.injected).toHaveLength(1);
    await first.db.close();
    open.delete(first);

    const second = await process_();
    const harness = buildHarness({ split, chain, store: second.store });
    const rerun = await harness.engine.run(harness.request);

    expect(rerun.injected).toEqual([]);
    expect(rerun.status).toBe('settled');
    expect(chain.injected.size).toBe(1);
    expect(harness.signer.signed).toHaveLength(0);
  });

  it('stores mutez as exact integers, never as a float', async () => {
    const chain = new FakeChain();
    const opened = await process_();
    const harness = buildHarness({ split, chain, store: opened.store });
    const result = await harness.engine.run(harness.request);

    // Straight out of SQLite, before the store decodes anything.
    const raw = await opened.db.query(
      'SELECT pool, total_to_send FROM distributions WHERE baker_id = ? AND cycle = ?',
      [BAKER, CYCLE],
    );
    expect(typeof raw[0]!.pool).toBe('bigint');
    const columns = await opened.db.query('PRAGMA table_info(distributions)');
    const poolColumn = columns.find((column) => column.name === 'pool')!;
    expect(String(poolColumn.type)).toBe('INTEGER');

    const snapshot = (await opened.store.getDistribution(BAKER, CYCLE))!;
    expect(typeof snapshot.lines[0]!.amountMutez).toBe('bigint');
    expect(snapshot.distribution.createdAt).toBeInstanceOf(Date);
    expect(sumMutez(snapshot.lines.map((line) => line.amountMutez))).toBe(result.totalSent);
  });

  it('still refuses a second distribution of the same cycle after a reopen', async () => {
    const chain = new FakeChain();
    const first = await process_();
    const harness = buildHarness({ split, chain, store: first.store });
    await harness.engine.run(harness.request);
    await first.db.close();
    open.delete(first);

    const second = await process_();
    const existing = await second.store.getDistribution(BAKER, CYCLE);
    await expect(
      second.store.createDistribution({
        distribution: { ...existing!.distribution, network: 'testnet' },
        lines: [],
        batches: [],
      }),
    ).rejects.toThrow(/already has a distribution for cycle/);
  });
});
