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
| Start without a signer endpoint, or without a ceiling | there is no fallback to fall back to |
| Distribute a cycle a denunciation can still reduce | `denunciation_period + slashing_delay`, both read from the chain |
| Carry a monetary value in a `number` | `Math.floor(0.00397 * 1e6)` is 3969 |

Each refusal has a test that makes it fire. A check whose condition cannot be
false is worse than no check.

## The minimum payment

The minimum is the network fee of the transfer itself, plus the allocation
burn when the destination has to be created, and it comes from
`estimate.batch()` at distribution time. Anything below it accumulates to the
next cycle as a debt to the delegator.

It is not a constant, and writing the measured 477 mutez into the code would
repeat the mistake this package exists to remove: that was one day's median
over 5957 transfers, the mean was 543, and the fee moves with demand. The cut
that was applied is written to the delegator's row, because after the cycle it
is not reproducible from anything on chain.

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
    bakerFloorMutez: 0n,
    limits: loadPayoutLimits(),
  },
});
```

## Verifying

```
npm run verify
```

Runs three source scanners before the tests: no protocol constant written
down, no `number` in the money path, no local signing key anywhere. Each
scanner has its own test proving it rejects a file that breaks its rule.

## What is not proven here

A full payout on Bakingnet, reconciled against the chain, needs a funded key,
a running `octez-signer` and network access. The arithmetic, the state machine
and every refusal above are covered by unit tests, including a run with 60 258
delegators; the end-to-end run is the QA harness's job (BRES-44) and has to
happen on a host that has those three things.

The byte layout the client authenticator signs over must be confirmed against
the deployed `octez-signer` before the first run that moves funds. A mismatch
fails closed — the signer refuses the request — which is the direction a wrong
guess should fail in.
