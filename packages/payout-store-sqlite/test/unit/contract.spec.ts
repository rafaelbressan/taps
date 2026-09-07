import { InvariantViolationError } from '@tezos-suite/chain';
import {
  DuplicateDistributionError,
  DuplicateOperationError,
  DuplicateSettlementError,
  InMemoryPayoutStore,
  type PayoutStore,
} from '@tezos-suite/payout';
import { NodeSqliteDatabase } from '../../src/node-sqlite';
import { migrate } from '../../src/migrate';
import { SqlitePayoutStore } from '../../src/store';
import {
  ALICE,
  BAKER,
  BOB,
  newDistribution,
  newSettlement,
  operationHash,
  withOpenDebt,
} from '../helpers/fixtures';

/**
 * One suite, two stores.
 *
 * The claim the whole payout engine rests on is "the constraint is what stops
 * a duplicate payment, not the engine's control flow". That claim is only
 * checkable if the constraint holds in every implementation of the port, so
 * the reference store and the one that ships run the same tests here. A
 * behaviour that only the in-memory store has is a behaviour the baker does
 * not get.
 */

interface Implementation {
  readonly name: string;
  open(): Promise<{ store: PayoutStore; close(): Promise<void> }>;
}

const IMPLEMENTATIONS: Implementation[] = [
  {
    name: 'InMemoryPayoutStore',
    async open() {
      return { store: new InMemoryPayoutStore(), close: async () => {} };
    },
  },
  {
    name: 'SqlitePayoutStore',
    async open() {
      const db = new NodeSqliteDatabase(':memory:');
      await migrate(db);
      return { store: new SqlitePayoutStore(db), close: () => db.close() };
    },
  },
];

for (const implementation of IMPLEMENTATIONS) {
  describe(implementation.name, () => {
    let store: PayoutStore;
    let close: () => Promise<void>;

    beforeEach(async () => {
      const opened = await implementation.open();
      store = opened.store;
      close = opened.close;
    });
    afterEach(() => close());

    describe('one distribution per (baker, cycle)', () => {
      it('writes the plan and reads it back whole', async () => {
        const snapshot = await store.createDistribution(newDistribution());

        expect(snapshot.distribution.status).toBe('planned');
        expect(snapshot.distribution.totalToSend).toBe(719_997n);
        expect(snapshot.distribution.remainder).toBe(3n);
        expect(snapshot.lines.map((line) => line.address).sort()).toEqual(
          [ALICE, BOB].sort(),
        );
        expect(snapshot.lines.every((line) => line.result === 'planned')).toBe(true);
        expect(snapshot.batches[0]!.transfers).toHaveLength(2);
        expect(snapshot.batches[0]!.transfers[0]!.amountMutez).toBe(400_000n);
        expect(snapshot.batches[0]!.opHash).toBeNull();
      });

      it('refuses the second distribution of the same cycle', async () => {
        await store.createDistribution(newDistribution());
        await expect(store.createDistribution(newDistribution())).rejects.toBeInstanceOf(
          DuplicateDistributionError,
        );
      });

      it('refuses a plan that lists the same delegator twice', async () => {
        const input = newDistribution();
        const duplicated = {
          ...input,
          lines: [...input.lines, input.lines[0]!],
        };
        await expect(store.createDistribution(duplicated)).rejects.toBeInstanceOf(
          InvariantViolationError,
        );
      });

      it('leaves nothing behind when a plan is refused', async () => {
        const input = newDistribution();
        await expect(
          store.createDistribution({ ...input, lines: [...input.lines, input.lines[0]!] }),
        ).rejects.toThrow();
        expect(await store.getDistribution(BAKER, 1336)).toBeUndefined();
      });
    });

    describe('the operation hash is durable, and owned by exactly one place', () => {
      it('records the intent before anything is injected', async () => {
        await store.createDistribution(newDistribution());
        const at = new Date('2026-09-01T10:00:00Z');
        await store.recordInjectionIntent({
          bakerId: BAKER,
          cycle: 1336,
          index: 0,
          opHash: operationHash(1),
          counter: '42',
          branch: 'BLbranch',
          branchLevel: 100,
          at,
        });

        const batch = await store.getBatch(BAKER, 1336, 0);
        expect(batch!.opHash).toBe(operationHash(1));
        expect(batch!.status).toBe('pending');
        expect(batch!.attempts).toHaveLength(1);
        expect(batch!.injectedAt!.toISOString()).toBe(at.toISOString());

        const snapshot = await store.getDistribution(BAKER, 1336);
        expect(snapshot!.distribution.status).toBe('sending');
      });

      it('refuses the same hash for two different batches', async () => {
        await store.createDistribution(newDistribution(1336));
        await store.createDistribution(newDistribution(1337));
        const intent = {
          bakerId: BAKER,
          index: 0,
          opHash: operationHash(2),
          counter: '42',
          branch: 'BLbranch',
          branchLevel: 100,
          at: new Date(),
        };
        await store.recordInjectionIntent({ ...intent, cycle: 1336 });
        await expect(
          store.recordInjectionIntent({ ...intent, cycle: 1337 }),
        ).rejects.toBeInstanceOf(DuplicateOperationError);
      });

      it('refuses a fresh attempt while the previous hash may still land', async () => {
        await store.createDistribution(newDistribution());
        const base = {
          bakerId: BAKER,
          cycle: 1336,
          index: 0,
          counter: '42',
          branch: 'BLbranch',
          branchLevel: 100,
          at: new Date(),
        };
        await store.recordInjectionIntent({ ...base, opHash: operationHash(3) });
        await expect(
          store.recordInjectionIntent({ ...base, opHash: operationHash(4) }),
        ).rejects.toBeInstanceOf(InvariantViolationError);
      });

      it('accepts a fresh attempt once the chain says the old one expired, and keeps both', async () => {
        await store.createDistribution(newDistribution());
        const base = {
          bakerId: BAKER,
          cycle: 1336,
          index: 0,
          counter: '42',
          branch: 'BLbranch',
          branchLevel: 100,
          at: new Date(),
        };
        await store.recordInjectionIntent({ ...base, opHash: operationHash(5) });
        await store.recordBatchStatus({
          bakerId: BAKER,
          cycle: 1336,
          index: 0,
          status: 'expired',
        });
        await store.recordInjectionIntent({ ...base, opHash: operationHash(6) });

        const batch = await store.getBatch(BAKER, 1336, 0);
        expect(batch!.opHash).toBe(operationHash(6));
        expect(batch!.attempts.map((attempt) => attempt.opHash)).toEqual([
          operationHash(5),
          operationHash(6),
        ]);
      });

      it('does not append an attempt when the same hash is recorded twice', async () => {
        await store.createDistribution(newDistribution());
        const intent = {
          bakerId: BAKER,
          cycle: 1336,
          index: 0,
          opHash: operationHash(7),
          counter: '42',
          branch: 'BLbranch',
          branchLevel: 100,
          at: new Date(),
        };
        await store.recordInjectionIntent(intent);
        await store.recordInjectionIntent(intent);
        expect((await store.getBatch(BAKER, 1336, 0))!.attempts).toHaveLength(1);
      });
    });

    describe('settlement lands whole or not at all', () => {
      it('writes line results, status and carry-over together', async () => {
        await store.createDistribution(newDistribution());
        await store.settleDistribution({
          bakerId: BAKER,
          cycle: 1336,
          status: 'settled',
          lines: [
            { address: ALICE, result: 'applied', batchIndex: 0, opHash: operationHash(8) },
            { address: BOB, result: 'deferred', batchIndex: null, opHash: null },
          ],
          carryOver: new Map([[BOB, 319_997n]]),
          at: new Date('2026-09-02T00:00:00Z'),
        });

        const snapshot = await store.getDistribution(BAKER, 1336);
        expect(snapshot!.distribution.status).toBe('settled');
        const alice = snapshot!.lines.find((line) => line.address === ALICE)!;
        expect(alice.result).toBe('applied');
        expect(alice.opHash).toBe(operationHash(8));
        expect(await store.loadCarryOver(BAKER)).toEqual(new Map([[BOB, 319_997n]]));
      });

      it('rolls back completely when one line is unknown', async () => {
        await store.createDistribution(newDistribution());
        await expect(
          store.settleDistribution({
            bakerId: BAKER,
            cycle: 1336,
            status: 'settled',
            lines: [
              { address: ALICE, result: 'applied', batchIndex: 0, opHash: operationHash(9) },
              { address: 'tz1nobody', result: 'applied', batchIndex: 0, opHash: null },
            ],
            carryOver: new Map(),
            at: new Date(),
          }),
        ).rejects.toBeInstanceOf(InvariantViolationError);

        const snapshot = await store.getDistribution(BAKER, 1336);
        expect(snapshot!.distribution.status).toBe('planned');
        expect(snapshot!.lines.every((line) => line.result === 'planned')).toBe(true);
      });

      it('clears a carry-over row when the balance reaches zero', async () => {
        await withOpenDebt(store);
        expect(await store.loadCarryOver(BAKER)).toEqual(new Map([[ALICE, 900n]]));

        await store.settleDistribution({
          bakerId: BAKER,
          cycle: 1330,
          status: 'settled',
          lines: [],
          carryOver: new Map([[ALICE, 0n]]),
          at: new Date(),
        });
        expect(await store.loadCarryOver(BAKER)).toEqual(new Map());
      });
    });

    describe('debt settlement', () => {
      it('refuses the same settlement id twice', async () => {
        await withOpenDebt(store);
        await store.createDebtSettlement(newSettlement());
        await expect(store.createDebtSettlement(newSettlement())).rejects.toBeInstanceOf(
          DuplicateSettlementError,
        );
      });

      it('lists an open settlement and stops listing it once settled', async () => {
        await withOpenDebt(store);
        await store.createDebtSettlement(newSettlement());
        expect(await store.listOpenSettlements(BAKER)).toEqual(['ticket-1']);

        await store.recordSettlementIntent({
          bakerId: BAKER,
          settlementId: 'ticket-1',
          opHash: operationHash(11),
          counter: '7',
          branch: 'BLbranch',
          branchLevel: 200,
          at: new Date(),
        });
        await store.recordSettlementStatus({
          bakerId: BAKER,
          settlementId: 'ticket-1',
          status: 'settled',
          cleared: [ALICE],
          at: new Date(),
        });

        expect(await store.listOpenSettlements(BAKER)).toEqual([]);
        expect(await store.loadCarryOver(BAKER)).toEqual(new Map());
      });

      it('refuses to clear a debt without a settled settlement', async () => {
        await withOpenDebt(store);
        await store.createDebtSettlement(newSettlement());
        await expect(
          store.recordSettlementStatus({
            bakerId: BAKER,
            settlementId: 'ticket-1',
            status: 'sending',
            cleared: [ALICE],
            at: new Date(),
          }),
        ).rejects.toBeInstanceOf(InvariantViolationError);
        expect(await store.loadCarryOver(BAKER)).toEqual(new Map([[ALICE, 900n]]));
      });

      it('refuses to clear a debt for less than it is worth', async () => {
        await withOpenDebt(store);
        await store.createDebtSettlement({
          ...newSettlement(),
          lines: [
            {
              address: ALICE,
              amountMutez: 800n,
              feeMutez: 400n,
              gasLimit: 1_000n,
              storageLimit: 0n,
              burnMutez: 0n,
            },
          ],
          totalAmount: 800n,
        });
        await expect(
          store.recordSettlementStatus({
            bakerId: BAKER,
            settlementId: 'ticket-1',
            status: 'settled',
            cleared: [ALICE],
            at: new Date(),
          }),
        ).rejects.toBeInstanceOf(InvariantViolationError);
        expect(await store.loadCarryOver(BAKER)).toEqual(new Map([[ALICE, 900n]]));
      });

      it('shares the hash namespace with cycle batches', async () => {
        await withOpenDebt(store);
        await store.createDistribution(newDistribution());
        await store.recordInjectionIntent({
          bakerId: BAKER,
          cycle: 1336,
          index: 0,
          opHash: operationHash(12),
          counter: '1',
          branch: 'BLbranch',
          branchLevel: 1,
          at: new Date(),
        });
        await store.createDebtSettlement(newSettlement());
        await expect(
          store.recordSettlementIntent({
            bakerId: BAKER,
            settlementId: 'ticket-1',
            opHash: operationHash(12),
            counter: '2',
            branch: 'BLbranch',
            branchLevel: 2,
            at: new Date(),
          }),
        ).rejects.toBeInstanceOf(DuplicateOperationError);
      });
    });

    describe('cycle statuses and audit', () => {
      it('reports the status of every planned cycle', async () => {
        await store.createDistribution(newDistribution(1330));
        await store.createDistribution(newDistribution(1331));
        await store.setDistributionStatus(BAKER, 1330, 'settled', new Date());

        expect(await store.listCycleStatuses(BAKER)).toEqual(
          new Map([
            [1330, 'settled'],
            [1331, 'planned'],
          ]),
        );
      });

      it('keeps a bigint parameter a bigint through the audit trail', async () => {
        await store.appendAudit({
          at: new Date('2026-09-03T00:00:00Z'),
          bakerId: BAKER,
          cycle: 1336,
          actor: 'rafael',
          source: 'scheduler',
          action: 'payout.run',
          outcome: 'ok',
          params: { totalToSend: 719_997n, when: new Date('2026-09-03T00:00:00Z') },
          amountMutez: 719_997n,
          destinations: [ALICE, BOB],
        });

        const events = await store.listAudit(BAKER, 1336);
        expect(events).toHaveLength(1);
        expect(events[0]!.params.totalToSend).toBe(719_997n);
        expect(events[0]!.params.when).toBeInstanceOf(Date);
        expect(events[0]!.amountMutez).toBe(719_997n);
        expect(events[0]!.destinations).toEqual([ALICE, BOB]);
      });

      it('filters the audit trail by cycle', async () => {
        const base = {
          at: new Date(),
          bakerId: BAKER,
          actor: 'rafael',
          source: 'cli',
          action: 'payout.run',
          outcome: 'ok' as const,
          params: {},
        };
        await store.appendAudit({ ...base, cycle: 1330 });
        await store.appendAudit({ ...base, cycle: 1331 });
        expect(await store.listAudit(BAKER, 1330)).toHaveLength(1);
        expect(await store.listAudit(BAKER)).toHaveLength(2);
      });
    });
  });
}
