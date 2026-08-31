import { InvariantViolationError, feeRate, sumMutez } from '@tezos-suite/chain';
import {
  CycleCapExceededError,
  CycleNotDistributableError,
  DestinationNotAllowedError,
  StorageAllocationError,
} from '../../src/errors';
import { InMemoryPayoutStore } from '../../src/store/memory';
import { tz1, tz4 } from '../helpers/addresses';
import { buildHarness } from '../helpers/engine';
import { FakeChain, fakeEstimator } from '../helpers/fake-chain';
import { delegator, makeSplit } from '../helpers/split';

const BAKER = tz1(1);
const CYCLE = 1336;

const ALICE = tz1(101);
const BOB = tz1(102);
const CAROL = tz4(103);

function simpleSplit(cycle = CYCLE) {
  return makeSplit({
    baker: BAKER,
    cycle,
    ownDelegatedBalance: 1_000_000_000n,
    delegatedRewards: 28_057_420n,
    delegators: [
      delegator(ALICE, 4_000_000_000n),
      delegator(BOB, 3_000_000_000n),
      delegator(CAROL, 2_000_000_000n),
    ],
  });
}

describe('running the same cycle twice', () => {
  it('injects on the first run and nothing at all on the second', async () => {
    const harness = buildHarness({ split: simpleSplit() });

    const first = await harness.engine.run(harness.request);
    expect(first.status).toBe('settled');
    expect(first.injected).toHaveLength(1);
    expect(harness.chain.injected.size).toBe(1);

    const second = await harness.engine.run(harness.request);
    expect(second.injected).toEqual([]);
    expect(second.skipped).toEqual(first.injected);
    expect(second.status).toBe('settled');

    // Nothing new was even signed: the second run never got as far as asking.
    expect(harness.signer.signed).toHaveLength(1);
    expect(harness.chain.injected.size).toBe(1);
    expect(second.totalSent).toBe(first.totalSent);
  });
});

describe('a process that dies between injection and confirmation', () => {
  it('resumes without paying again when the operation did land', async () => {
    const chain = new FakeChain();
    const store = new InMemoryPayoutStore();
    const first = buildHarness({ split: simpleSplit(), chain, store });

    // The node accepted the operation and the answer was lost. This is the
    // exact case where the current TAPS injects the same batch a second time.
    chain.landThenFailNextInjection = true;
    await expect(first.engine.run(first.request)).rejects.toThrow(/connection reset/);

    const midway = await store.getDistribution(BAKER, CYCLE);
    const recorded = midway!.batches[0]!.opHash;
    expect(recorded).not.toBeNull();
    expect(chain.injected.has(recorded!)).toBe(true);

    const resumed = buildHarness({ split: simpleSplit(), chain, store });
    const result = await resumed.engine.run(resumed.request);

    expect(result.status).toBe('settled');
    expect(result.injected).toEqual([]);
    expect(result.skipped).toEqual([recorded]);
    // One operation on chain, one signature ever asked for on the resume.
    expect(chain.injected.size).toBe(1);
    expect(resumed.signer.signed).toHaveLength(0);
  });

  it('will not resend while the previous hash can still land', async () => {
    const chain = new FakeChain();
    const store = new InMemoryPayoutStore();
    const first = buildHarness({ split: simpleSplit(), chain, store, confirmationPolls: 2 });

    // Written before injection, never injected: nothing on chain, and the
    // branch has not expired. Absence proves nothing yet.
    chain.failNextInjection = new Error('rpc unreachable');
    await expect(first.engine.run(first.request)).rejects.toThrow(/rpc unreachable/);

    const resumed = buildHarness({ split: simpleSplit(), chain, store, confirmationPolls: 2 });
    await expect(resumed.engine.run(resumed.request)).rejects.toThrow(
      /still "pending" after the polling budget/,
    );
    expect(chain.injected.size).toBe(0);
    // No second signature: a resend would have needed one.
    expect(resumed.signer.signed).toHaveLength(0);
  });

  it('resends only once the branch has expired, and keeps the old hash', async () => {
    const chain = new FakeChain();
    const store = new InMemoryPayoutStore();
    const first = buildHarness({ split: simpleSplit(), chain, store, confirmationPolls: 2 });

    chain.failNextInjection = new Error('rpc unreachable');
    await expect(first.engine.run(first.request)).rejects.toThrow(/rpc unreachable/);
    const abandoned = (await store.getDistribution(BAKER, CYCLE))!.batches[0]!.opHash!;

    // Past branch_level + max_operations_time_to_live: the operation can never
    // be included again, and only now is a resend safe.
    chain.headLevel += 700;

    const resumed = buildHarness({ split: simpleSplit(), chain, store });
    const result = await resumed.engine.run(resumed.request);

    expect(result.status).toBe('settled');
    expect(result.injected).toHaveLength(1);
    expect(result.injected[0]).not.toBe(abandoned);
    expect(chain.injected.size).toBe(1);

    const batch = (await store.getDistribution(BAKER, CYCLE))!.batches[0]!;
    // The abandoned attempt is still on record. Deleting it is what destroys
    // the evidence that the money may have moved.
    expect(batch.attempts.map((a) => a.opHash)).toEqual([abandoned, result.injected[0]]);
  });
});

describe('what the protocol already paid is never paid again', () => {
  it('distributes only the delegated pool', async () => {
    const split = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 1_000_000_000n,
      delegatedRewards: 10_000_000n,
      stakedShared: 90_000_000n,
      stakedEdge: 5_000_000n,
      stakedOwn: 7_000_000n,
      delegators: [delegator(ALICE, 9_000_000_000n)],
      stakers: [{ address: BOB, stakedBalance: 50_000_000_000n }],
    });
    const harness = buildHarness({ split });
    await harness.engine.run(harness.request);

    const snapshot = (await harness.store.getDistribution(BAKER, CYCLE))!;
    expect(snapshot.distribution.pool).toBe(10_000_000n);
    // A staker is not a delegator; nothing was addressed to one.
    expect(snapshot.batches[0]!.transfers.map((t) => t.address)).toEqual([ALICE]);
    expect(snapshot.lines.map((l) => l.address)).toEqual([ALICE]);
  });
});

describe('a destination that needs its account allocated', () => {
  it('gets the storage the estimate asked for, and the batch survives', async () => {
    const split = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 1_000_000_000n,
      delegatedRewards: 500_000_000n,
      delegators: [
        delegator(ALICE, 4_000_000_000n),
        delegator(BOB, 3_000_000_000n, true),
      ],
    });
    const harness = buildHarness({ split });
    const result = await harness.engine.run(harness.request);

    expect(result.status).toBe('settled');
    const batch = (await harness.store.getDistribution(BAKER, CYCLE))!.batches[0]!;
    const emptied = batch.transfers.find((t) => t.address === BOB)!;
    expect(emptied.storageLimit).toBe(257n);
    expect(batch.transfers.find((t) => t.address === ALICE)!.storageLimit).toBe(0n);
    // Both recipients are in the same batch and both are paid.
    expect(batch.transfers).toHaveLength(2);
  });

  it('refuses to build a batch that would come back backtracked', async () => {
    const split = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 1_000_000_000n,
      delegatedRewards: 500_000_000n,
      delegators: [delegator(BOB, 3_000_000_000n, true)],
    });
    // An estimator that hands back the fixed zero the current TAPS uses.
    const harness = buildHarness({
      split,
      estimate: fakeEstimator({ feeMutez: 500n, allocationStorage: 0n }),
    });
    await expect(harness.engine.run(harness.request)).rejects.toBeInstanceOf(
      StorageAllocationError,
    );
    expect(harness.signer.signed).toHaveLength(0);
  });
});

describe('the balance below the cut is a debt, not a discard', () => {
  it('carries it over and pays it in the next cycle', async () => {
    const store = new InMemoryPayoutStore();
    const dust = tz1(104);

    // Cycle N: `dust` earns less than one network fee.
    const splitN = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 0n,
      delegatedRewards: 100_000_000n,
      delegators: [
        delegator(ALICE, 99_999_000_000n),
        delegator(dust, 100_000n),
      ],
    });
    const splitNext = makeSplit({
      baker: BAKER,
      cycle: CYCLE + 1,
      ownDelegatedBalance: 0n,
      delegatedRewards: 1_000_000_000n,
      delegators: [
        delegator(ALICE, 99_999_000_000n),
        delegator(dust, 100_000n),
      ],
    });

    const chain = new FakeChain();
    const first = buildHarness({
      split: splitN,
      splitFor: (cycle) => (cycle === CYCLE ? splitN : splitNext),
      store,
      chain,
    });
    const firstRun = await first.engine.run(first.request);

    const dustLine = firstRun.lines.find((l) => l.address === dust)!;
    expect(dustLine.paid).toBe(false);
    expect(dustLine.withheld).toBeGreaterThan(0n);
    expect(dustLine.carriedOut).toBe(dustLine.payable);
    expect(await store.loadCarryOver(BAKER)).toEqual(new Map([[dust, dustLine.payable]]));

    const second = buildHarness({
      split: splitNext,
      splitFor: (cycle) => (cycle === CYCLE ? splitN : splitNext),
      store,
      chain,
    });
    const secondRun = await second.engine.run({ ...second.request, cycle: CYCLE + 1 });

    const nextLine = secondRun.lines.find((l) => l.address === dust)!;
    expect(nextLine.carriedIn).toBe(dustLine.carriedOut);
    expect(nextLine.payable).toBe(nextLine.net + nextLine.carriedIn);
    expect(nextLine.paid).toBe(true);
    expect(nextLine.amount).toBe(nextLine.payable);
    // Accumulating and never paying is the same as not paying.
    expect(await store.loadCarryOver(BAKER)).toEqual(new Map());
  });
});

describe('the cut comes from the estimate, so it moves with the network', () => {
  it('excludes a delegator at one fee and pays them at another', async () => {
    const dust = tz1(105);
    const split = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 0n,
      delegatedRewards: 100_000_000n,
      delegators: [
        delegator(ALICE, 99_999_000_000n),
        delegator(dust, 900_000n),
      ],
    });

    const busy = buildHarness({ split, estimate: fakeEstimator({ feeMutez: 2_000n }) });
    const busyRun = await busy.engine.run(busy.request);
    const busyLine = busyRun.lines.find((l) => l.address === dust)!;

    const calm = buildHarness({ split, estimate: fakeEstimator({ feeMutez: 100n }) });
    const calmRun = await calm.engine.run(calm.request);
    const calmLine = calmRun.lines.find((l) => l.address === dust)!;

    expect(busyLine.payable).toBe(calmLine.payable);
    expect(busyLine.minimum).toBe(2_000n);
    expect(calmLine.minimum).toBe(100n);
    expect(busyLine.paid).toBe(false);
    expect(calmLine.paid).toBe(true);
  });
});

describe('the decomposition is written down at distribution time', () => {
  it('records gross, commission, what was withheld and the cut that was used', async () => {
    const harness = buildHarness({ split: simpleSplit(), feeMutez: 700n });
    await harness.engine.run(harness.request);

    const snapshot = (await harness.store.getDistribution(BAKER, CYCLE))!;
    for (const line of snapshot.lines) {
      expect(line.grossMutez).toBe(line.commissionMutez + line.netMutez);
      expect(line.amountMutez + line.carriedOutMutez).toBe(line.payableMutez);
      // The estimated fee of that cycle. It is not reproducible afterwards,
      // which is the whole reason it is a column.
      expect(line.minimumMutez).toBe(700n);
      expect(line.delegatedBalanceMutez).toBeGreaterThan(0n);
    }

    const paid = sumMutez(
      snapshot.lines.filter((l) => l.result === 'applied').map((l) => l.amountMutez),
    );
    expect(paid).toBe(snapshot.distribution.totalToSend);
    expect(paid).toBe(sumMutez(snapshot.batches[0]!.transfers.map((t) => t.amountMutez)));

    const commission = sumMutez(snapshot.lines.map((l) => l.commissionMutez));
    // Per-line floor divisions cannot add up to the pool-level commission to
    // the last mutez; the gap is bounded by one mutez per delegator, and the
    // amount the baker actually retains is bakerFee plus the remainder.
    const drift =
      commission > snapshot.distribution.bakerFee
        ? commission - snapshot.distribution.bakerFee
        : snapshot.distribution.bakerFee - commission;
    expect(drift).toBeLessThanOrEqual(BigInt(snapshot.lines.length));
    expect(snapshot.distribution.remainder).toBeGreaterThanOrEqual(0n);
  });
});

describe('a destination outside the delegator list is never signed', () => {
  it('refuses before the signing request and blocks the cycle', async () => {
    const store = new InMemoryPayoutStore();
    const attacker = tz1(6666);

    // A batch whose destinations no longer match the lines: what execution on
    // the payout host would do to get a signature for its own address.
    await store.createDistribution({
      distribution: {
        bakerId: BAKER,
        cycle: CYCLE,
        network: 'testnet',
        protocolHash: 'PsTest',
        pool: 1_000_000n,
        ownShare: 0n,
        bakerFee: 0n,
        distributable: 1_000_000n,
        remainder: 0n,
        totalToSend: 1_000_000n,
        feeNumerator: 0n,
        feeDenominator: 100n,
        blockFeesIncluded: false,
        delegatorCount: 1,
      },
      lines: [
        {
          bakerId: BAKER,
          cycle: CYCLE,
          address: ALICE,
          delegatedBalanceMutez: 1n,
          grossMutez: 1_000_000n,
          commissionMutez: 0n,
          netMutez: 1_000_000n,
          carriedInMutez: 0n,
          payableMutez: 1_000_000n,
          minimumMutez: 500n,
          withheldMutez: 0n,
          amountMutez: 1_000_000n,
          carriedOutMutez: 0n,
          emptied: false,
        },
      ],
      batches: [
        {
          bakerId: BAKER,
          cycle: CYCLE,
          index: 0,
          transfers: [
            {
              address: attacker,
              amountMutez: 1_000_000n,
              feeMutez: 500n,
              gasLimit: 2_169n,
              storageLimit: 0n,
              burnMutez: 0n,
            },
          ],
          totalAmount: 1_000_000n,
          totalFees: 500n,
          totalBurn: 0n,
          totalGas: 2_169n,
          totalStorage: 0n,
        },
      ],
    });

    const harness = buildHarness({ split: simpleSplit(), store });
    await expect(harness.engine.run(harness.request)).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );

    expect(harness.signer.signed).toHaveLength(0);
    expect(harness.chain.injected.size).toBe(0);
    const snapshot = (await harness.store.getDistribution(BAKER, CYCLE))!;
    expect(snapshot.distribution.status).toBe('blocked');

    const audit = await harness.store.listAudit(BAKER, CYCLE);
    expect(audit.some((e) => e.action === 'signature.refused' && e.outcome === 'refused')).toBe(
      true,
    );

    // A blocked cycle is never picked up again on its own.
    await expect(harness.engine.run(harness.request)).rejects.toThrow(/blocked for human review/);
  });
});

describe('the guards that stop a run before it signs anything', () => {
  it('refuses to move more than the configured ceiling', async () => {
    const harness = buildHarness({ split: simpleSplit() });
    await expect(
      harness.engine.run({
        ...harness.request,
        policy: { ...harness.request.policy, limits: { cycleCapMutez: 1_000n } },
      }),
    ).rejects.toBeInstanceOf(CycleCapExceededError);
    expect(harness.signer.signed).toHaveLength(0);
    expect(await harness.store.getDistribution(BAKER, CYCLE)).toBeUndefined();
  });

  it('refuses a cycle a denunciation can still reduce', async () => {
    const harness = buildHarness({ split: simpleSplit(), headCycle: CYCLE });
    await expect(harness.engine.run(harness.request)).rejects.toBeInstanceOf(
      CycleNotDistributableError,
    );
  });

  it('refuses when the baker cannot fund amounts, fees and burns', async () => {
    const chain = new FakeChain();
    chain.balance = 1_000n;
    const harness = buildHarness({ split: simpleSplit(), chain });
    await expect(harness.engine.run(harness.request)).rejects.toBeInstanceOf(
      InvariantViolationError,
    );
    expect(harness.signer.signed).toHaveLength(0);
  });

  it('refuses a split whose delegator list does not add up', async () => {
    const truncated = {
      ...simpleSplit(),
      externalDelegatedBalance: 9_000_000_001n,
    };
    const harness = buildHarness({ split: truncated });
    await expect(harness.engine.run(harness.request)).rejects.toThrow(
      /delegator list is truncated/,
    );
  });
});

describe('the audit trail', () => {
  it('records who asked, from where, for which destinations and with which hash', async () => {
    const harness = buildHarness({ split: simpleSplit() });
    const result = await harness.engine.run({
      ...harness.request,
      actor: 'rafael',
      source: 'cli@workstation',
    });

    const audit = await harness.store.listAudit(BAKER, CYCLE);
    expect(audit.every((e) => e.actor === 'rafael' && e.source === 'cli@workstation')).toBe(true);

    const signature = audit.find((e) => e.action === 'signature.requested')!;
    expect(signature.params['destinations']).toEqual([ALICE, BOB, CAROL]);
    expect(signature.params['totalAmountMutez']).toBe(result.totalSent.toString());

    const injection = audit.find((e) => e.action === 'injection.recorded')!;
    expect(injection.params['opHash']).toBe(result.injected[0]);
    // The hash is on record before the node is asked to accept anything.
    expect(audit.indexOf(injection)).toBeLessThan(
      audit.findIndex((e) => e.action === 'injection.accepted'),
    );

    expect(audit.some((e) => e.action === 'distribution.settled' && e.outcome === 'ok')).toBe(
      true,
    );
  });

  it('names every delegator it held back, and why', async () => {
    const dust = tz1(106);
    const split = makeSplit({
      baker: BAKER,
      cycle: CYCLE,
      ownDelegatedBalance: 0n,
      delegatedRewards: 100_000_000n,
      delegators: [delegator(ALICE, 99_999_000_000n), delegator(dust, 100_000n)],
    });
    const harness = buildHarness({ split });
    await harness.engine.run(harness.request);

    const withheld = (await harness.store.listAudit(BAKER, CYCLE)).filter(
      (e) => e.action === 'delegator.withheld',
    );
    // Silent exclusion on the money path is the worst category of bug here.
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.params['address']).toBe(dust);
    expect(withheld[0]!.params['cutMutez']).toBe('500');
  });
});

describe('a batch that lands with a non-applied status', () => {
  it('is not counted as paid, and the money is owed next cycle', async () => {
    const chain = new FakeChain();
    chain.nextInjectionStatus = 'backtracked';
    const harness = buildHarness({ split: simpleSplit(), chain, attemptsPerBatch: 1 });

    const result = await harness.engine.run(harness.request);
    expect(result.status).toBe('failed');
    expect(result.totalSent).toBe(0n);

    const carry = await harness.store.loadCarryOver(BAKER);
    expect([...carry.keys()].sort()).toEqual([ALICE, BOB, CAROL].sort());
    for (const line of result.lines) {
      expect(carry.get(line.address)).toBe(line.payable);
    }
  });
});

describe('the commission is an integer ratio', () => {
  it('never invents a mutez, whatever the ratio', async () => {
    const harness = buildHarness({ split: simpleSplit() });
    const result = await harness.engine.run({
      ...harness.request,
      policy: { ...harness.request.policy, fee: feeRate(1n, 3n) },
    });
    const snapshot = (await harness.store.getDistribution(BAKER, CYCLE))!;
    const distributed = sumMutez(result.lines.map((l) => l.net));
    expect(
      snapshot.distribution.ownShare +
        snapshot.distribution.bakerFee +
        distributed +
        snapshot.distribution.remainder,
    ).toBe(snapshot.distribution.pool);
  });
});
