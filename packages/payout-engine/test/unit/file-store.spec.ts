import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sumMutez } from '@tezos-suite/chain';
import { payoutFactor } from '../../src/minimum';
import { FilePayoutStore } from '../../src/store/file';
import { tz1 } from '../helpers/addresses';
import { buildHarness } from '../helpers/engine';
import { FakeChain } from '../helpers/fake-chain';
import { delegator, makeSplit } from '../helpers/split';

/**
 * The durability half of the idempotency claim.
 *
 * "The hash is written before the operation is injected" is a statement about
 * what survives the process, so proving it needs a store that outlives the
 * process. Every engine test elsewhere shares one in-memory store between two
 * engine instances, which shows the control flow is right but says nothing
 * about the disk. Here the second engine reads the state back from a file it
 * did not write.
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
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'taps-payout-file-store-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('resumes from disk without paying again after the answer is lost', async () => {
    const chain = new FakeChain();

    // First process: the node accepted the operation and the answer was lost.
    const first = buildHarness({
      split,
      chain,
      store: new FilePayoutStore(directory),
    });
    chain.landThenFailNextInjection = true;
    await expect(first.engine.run(first.request)).rejects.toThrow(/connection reset/);

    // Second process. A brand new store object, reading a file it did not
    // write, in a run that shares nothing with the first but the directory.
    const reopened = new FilePayoutStore(directory);
    const recorded = (await reopened.getDistribution(BAKER, CYCLE))!.batches[0]!.opHash!;
    expect(chain.injected.has(recorded)).toBe(true);

    const second = buildHarness({ split, chain, store: reopened });
    const result = await second.engine.run(second.request);

    expect(result.status).toBe('settled');
    expect(result.injected).toEqual([]);
    expect(result.skipped).toEqual([recorded]);
    expect(chain.injected.size).toBe(1);
    expect(second.signer.signed).toHaveLength(0);
  });

  it('keeps a second run of a settled cycle from injecting anything', async () => {
    const chain = new FakeChain();
    const first = buildHarness({ split, chain, store: new FilePayoutStore(directory) });
    const settled = await first.engine.run(first.request);
    expect(settled.injected).toHaveLength(1);

    const second = buildHarness({
      split,
      chain,
      store: new FilePayoutStore(directory),
    });
    const rerun = await second.engine.run(second.request);
    expect(rerun.injected).toEqual([]);
    expect(rerun.status).toBe('settled');
    expect(chain.injected.size).toBe(1);
    expect(second.signer.signed).toHaveLength(0);
  });

  it('writes mutez as tagged integers, never as a JSON number', async () => {
    const chain = new FakeChain();
    const harness = buildHarness({
      split,
      chain,
      store: new FilePayoutStore(directory),
    });
    const result = await harness.engine.run(harness.request);

    const raw = readFileSync(join(directory, 'payout-store.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const encoded = JSON.stringify(parsed);

    // A JSON number is a float. `9007199254740993` does not survive one, and
    // neither does the difference between 3969 and 3970 mutez once anything
    // downstream starts doing arithmetic on it.
    expect(encoded).toContain('bigint:');
    expect(/"(pool|amountMutez|payableMutez|totalToSend)":\s*\d/.test(encoded)).toBe(false);

    // Round-tripped values are bigints again, and they still add up.
    const reopened = new FilePayoutStore(directory);
    const snapshot = (await reopened.getDistribution(BAKER, CYCLE))!;
    expect(typeof snapshot.distribution.pool).toBe('bigint');
    expect(typeof snapshot.lines[0]!.amountMutez).toBe('bigint');
    expect(snapshot.distribution.createdAt).toBeInstanceOf(Date);
    expect(sumMutez(snapshot.lines.map((line) => line.amountMutez))).toBe(result.totalSent);
  });

  it('still refuses a second distribution of the same cycle after a reopen', async () => {
    const chain = new FakeChain();
    const harness = buildHarness({
      split,
      chain,
      store: new FilePayoutStore(directory),
    });
    await harness.engine.run(harness.request);

    const reopened = new FilePayoutStore(directory);
    const existing = await reopened.getDistribution(BAKER, CYCLE);
    await expect(
      reopened.createDistribution({
        distribution: {
          ...existing!.distribution,
          network: 'testnet',
        },
        lines: [],
        batches: [],
      }),
    ).rejects.toThrow(/already has a distribution for cycle/);
  });

  it('remembers a debt settlement across the process that made it', async () => {
    const chain = new FakeChain();
    const TINY = tz1(203);
    const dusty = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 0n,
      delegatedRewards: 10_000_000n,
      delegators: [delegator(ALICE, 999_000_000_000n), delegator(TINY, 20_000_000n)],
    });

    const first = buildHarness({
      split: dusty,
      chain,
      feeMutez: 500n,
      payoutFactor: payoutFactor(1n, 1n),
      store: new FilePayoutStore(directory),
    });
    await first.engine.run(first.request);

    const request = {
      bakerId: BAKER,
      settlementId: 'ticket-9',
      addresses: [TINY],
      actor: 'rafael',
      source: 'cli',
      reason: 'left the baker with an unclearable balance',
      limits: { cycleCapMutez: 10_000_000_000n },
    };
    // The node accepted it and the answer was lost, in the process that died.
    chain.landThenFailNextInjection = true;
    await expect(first.engine.settleDebt(request)).rejects.toThrow(/connection reset/);

    // Second process, reading a file it did not write. The debt is still on
    // record and the hash is there to ask the chain about.
    const reopened = new FilePayoutStore(directory);
    const midway = (await reopened.getDebtSettlement(BAKER, 'ticket-9'))!;
    expect(midway.opHash).not.toBeNull();
    expect(chain.injected.has(midway.opHash!)).toBe(true);
    expect((await reopened.loadCarryOver(BAKER)).get(TINY)).toBe(190n);

    const resumed = buildHarness({
      split: dusty,
      chain,
      feeMutez: 500n,
      payoutFactor: payoutFactor(1n, 1n),
      store: reopened,
    });
    const result = await resumed.engine.settleDebt(request);

    expect(result.status).toBe('settled');
    expect(result.injected).toEqual([]);
    expect((await reopened.loadCarryOver(BAKER)).get(TINY)).toBeUndefined();
  });
});
