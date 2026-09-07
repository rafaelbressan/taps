# @tezos-suite/payout

The payout engine of the TAPS. It turns a reward split into money that moves
once, or does not move at all.

Built on `@tezos-suite/chain` (BRES-42), which owns the protocol constants,
the TzKT client and the arithmetic. This package owns what happens around
them: persistence, idempotency, batching, signing and the audit trail.

## The one idea

Idempotency is a property of the design, not a flag:

1. The operation hash is derived from the SIGNED bytes, so it exists before
   the operation does. `prepare()` produces it; the caller writes it down;
   only then `inject()` runs.
2. Nothing is ever resent without reading the previous hash's state on chain,
   and a resend needs `expired` or `failed` — the two states the chain can
   confirm. `pending` means the operation may still land.
3. `(baker_id, cycle)` is unique in the database, so a second distribution of
   the same cycle is impossible rather than unlikely.
4. An attempt is appended, never replaced. The hash of an abandoned attempt is
   the only evidence that the money may already have left.

`max_operations_time_to_live` is 600 blocks, one hour today. Before that, the
absence of an operation from the mempool proves nothing at all. Treating it as
"never injected" is the exact step that pays everybody twice.

## What it refuses to do

| Refusal | Why |
| --- | --- |
| Pay `*StakedShared`, `*StakedOwn` or `*StakedEdge` | the protocol already credited them; paying is paying twice |
| Send to an address that is not a delegator of the cycle | the signer will sign anything valid; this is the defence against signer misuse |
| Move more than the configured per-cycle ceiling | above it, a human approves |
| Build a batch with `storage_limit: 0` for a destination that needs allocating | one such destination leaves the WHOLE batch `backtracked` |
| Start without a signer endpoint, a ceiling, a K or an owed-cycle limit | there is no fallback to fall back to |
| Pay any cycle when more are owed than the configured limit | a week of cycles paid unattended is the surprise the limit exists for |
| Move to the next cycle when one did not settle | stepping over a broken cycle is how one silently goes unpaid |
| Clear a debt without a confirmed operation | a debt cleared on an unconfirmed send is a debt silently forgiven |
| Distribute a cycle a denunciation can still reduce | `denunciation_period + slashing_delay`, both read from the chain |
| Carry a monetary value in a `number` | `Math.floor(0.00397 * 1e6)` is 3969 |

Each refusal has a test that makes it fire. A check whose condition cannot be
false is worse than no check.

## The cut (RN-24)

A payment enters the batch only when what is owed covers **K times** the
estimated cost of that very transfer — fee plus the allocation burn when the
destination has to be created, both from `estimate.batch()` at distribution
time. K is the baker's, from `TAPS_PAYOUT_MIN_FACTOR`, and there is no
default.

It is relative rather than absolute because writing the measured 477 mutez
into the code would repeat the mistake this package exists to remove: that was
one day's median over 5957 transfers, the mean was 543, and the fee moves with
demand.

| Cut | Share of the pool that becomes network fees |
| --- | --- |
| none | 4.50% |
| K = 1 | 1.82% |

Measured on the reference baker, cycle 1336, 2919 delegators. A larger K
pushes that down further and makes the small delegator wait more cycles for a
larger payment; the curve is measurable for a specific baker, and choosing on
it is the baker's call.

Below the cut nothing is discarded. The amount becomes the baker's debt to
that delegator, accumulates across cycles and is paid the moment it clears —
`paid + open debt == owed` is a property test over random input. Both halves
of the cut are written down (K on the distribution, the estimated cost on the
delegator's row), because after the cycle neither is reproducible from
anything on chain.

A delegator who stops delegating below the cut never clears it on their own,
and the debt does not expire because they went quiet. `engine.settleDebt()` is
the way out: an explicit, recorded, human-asked payment that accepts costing
more in fee than it moves. It belongs to no cycle, makes at most one attempt,
and clears the debt only against a confirmed operation.

`buildCycleReport()` builds a row for EVERY delegator, below the cut included,
with what the cycle owed them and the debt they are carrying — the cut is not
a reason to make the small ones disappear.

## The queue of owed cycles (RN-28)

`CycleQueue` walks every distributable cycle that has not settled, in
ascending order, one at a time — each its own distribution, its own batch, its
own hash.

Two stops, both loud:

- **Above `TAPS_PAYOUT_MAX_OWED_CYCLES`, nothing is injected.** The owed
  cycles are recorded, priced and reported, and a human decides. This exists
  for the concrete scenario of a wallet emptied in one go after a fortnight
  away.
- **A cycle that does not settle stops the queue there.** It does not step
  over it. Skipping "so the queue keeps moving" is how a cycle gets paid twice
  or never, with nobody noticing.

## Batching

Sized by accumulated estimated gas against `hard_gas_limit_per_block`, read
from the chain — never by a fixed count. Batches of 448 transfers run on
mainnet at 90.6% of the block gas limit; `MAX_BATCH_SIZE = 100` is not
dangerous, it is four times too conservative, and every extra batch is another
window for a partial failure.

## Wiring

```ts
const constants = await constantsProvider.get();

const engine = new PayoutEngine({
  store: prismaPayoutStore,
  rpc: new HttpPayoutRpc(network.rpcUrl),
  signer: new OctezRemoteSigner(
    loadSignerConfig(),
    new Ed25519ClientAuthenticator(loadSignerConfig().clientAuthKey),
  ),
  injector: new RpcBatchInjector(rpc, signer),
  operations: new TzKTOperationStateSource(tzktHttp, headSource),
  constants: () => constantsProvider.get(),
  loadSplit: (baker, cycle) => fetchRewardSplit(tzktHttp, baker, cycle),
  headCycle: async () => (await fetchHead(tzktHttp)).cycle,
  estimate: createChunkedEstimator(tezos, constants),
  network: network.name,
});

await engine.run({
  bakerId, cycle,
  actor: 'rafael', source: 'cli@workstation',
  policy: {
    fee: feeRate(500n, 10_000n),
    includeBlockFees: false,
    payoutFactor: loadPayoutFactor(),
    limits: loadPayoutLimits(),
  },
});
```

Or, to work the backlog instead of one named cycle:

```ts
const queue = new CycleQueue({
  engine, store: prismaPayoutStore,
  constants: () => constantsProvider.get(),
  headCycle: async () => (await fetchHead(tzktHttp)).cycle,
  loadSplit: (baker, cycle) => fetchRewardSplit(tzktHttp, baker, cycle),
});

const result = await queue.run({
  bakerId,
  fromCycle,                       // the first cycle this installation owns
  actor: 'scheduler', source: 'cron@host',
  policy,
  limits: loadQueueLimits(),
});
if (result.halted) notify(result);  // owed, priced, and nothing injected
```

## Verifying

```
npm run verify
```

Runs three source scanners before the tests: no protocol constant written
down, no `number` in the money path, no local signing key anywhere. Each
scanner has its own test proving it rejects a file that breaks its rule.

## Running it against Bakingnet

The QA harness (BRES-44) drives this engine directly:

```
npm run run -- --engine taps
```

Without the flag it runs its own reference oracle, which is what CI measures.
The setup that has to exist first — the `octez-signer` host, the funded key —
is written down in `docs/deployment/BAKINGNET-PAYOUT-VALIDATION.md`.

## What is not proven here

A full payout on Bakingnet, reconciled against the chain, needs a funded key,
a running `octez-signer` and network access. The arithmetic, the state machine
and every refusal above are covered by unit tests, including a run with 60 258
delegators and a resume that reads its state back from disk in a second
process.

The byte layout the client authenticator signs over must be confirmed against
the deployed `octez-signer` before the first run that moves funds. A mismatch
fails closed — the signer refuses the request — which is the direction a wrong
guess should fail in.
