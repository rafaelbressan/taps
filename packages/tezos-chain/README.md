# @tezos-suite/chain

The chain layer of the Tezos suite: what the network actually does today, and
the arithmetic of every mutez. Shared by **Tezzet** (wallet) and **TAPS**
(reward distribution) — ADR-0001 keeps this layer in TypeScript in both
finalists, so there is one implementation, not two.

It has no NestJS, no Prisma and no product coupling: `@taquito/taquito` and
`@taquito/utils` are the only runtime dependencies. Moving it into its own
repository is a `git mv`.

Powered by [TzKT API](https://tzkt.io) — attribution is a licence requirement
of the free tier, and `TZKT_ATTRIBUTION` is exported so every product surface
can render it.

## The one rule

**A protocol constant is read from the chain at runtime and never written into
the code.**

`blocks_per_cycle` is 14400 on mainnet and Shadownet, and **3600 on
Bakingnet**. Same protocol, same Octez version, different value. A literal is
not slightly wrong on the TAPS testnet, it is wrong by 4x — and silently,
because nothing in a response contradicts a local value.

`npm run check:constants` fails the build on any protocol constant found in
the source. It is wired into CI, and there is a test proving it rejects
`BLOCKS_PER_CYCLE = 4096`.

## What it does

| Module | What it owns |
|---|---|
| `rpc/protocol-constants` | `/context/constants` at runtime, cached by `(chain_id, protocol_hash)`, TTL one cycle |
| `rpc/staking-parameters` | the baker's on-chain edge, in **billionths** |
| `tzkt/http` | status before parse, 429 backoff with jitter, 204 as unknown, freshness headers, concurrency 1–4 |
| `tzkt/reward-split` | the split with full pagination, and the two invariants that abort |
| `rewards/payout` | Adaptive Issuance payout, integer-only |
| `batch/estimate` `batch/plan` | one `estimate.batch()`, batches sized by accumulated gas |
| `confirmation` | Tenderbake finality and the only safe moment to resend |
| `address` | `validateAddress` from `@taquito/utils` — checksum included, `tz4` accepted |
| `mutez` | `bigint` mutez end to end; XTZ is a display string |

## Things that are easy to get wrong

**`*StakedShared` was already paid by the protocol.** Σ(`*StakedShared`)
equals Σ(`actualStakers[].rewards`) to the mutez. `*StakedOwn` and
`*StakedEdge` belong to the baker. The only pool a baker distributes is
Σ(`*Delegated`), which TzKT documents as landing "on baker's liquid balance".
Paying any of the other three pays twice.

**Do not recompute the edge.** The protocol applies it per reward event, with
rounding each time. Reconstructing it from the cycle total was measured 706
mutez off on one Everstake cycle. Read the reported `*StakedEdge` and
`*StakedShared`.

**Pagination is not an edge case.** The default page is 100 and the ceiling is
10 000. Everstake had 60 258 delegators in cycle 1336. A truncated list raises
nothing on its own — it overpays whoever was listed and pays zero to everyone
else. `assertDelegatorListComplete` is the check that catches it, and it
aborts.

**No `|| 0` on an external field.** Eight of the eight fields the previous
client summed no longer exist. Each `|| 0` turned a removed field into a
plausible number and the system reported success.

**The minimum payout is not a constant.** It is the fee estimated for *that*
transfer at distribution time, plus the allocation burn when the destination
is emptied. Amounts below it accumulate to the next cycle as debt to the
delegator. Writing `MIN_PAYOUT = 477` repeats the mistake this package exists
to remove: the fee moves with demand.

## Configuration

Endpoints are configuration and have no defaults. See `.env.example`.

```
TEZOS_NETWORK=  TEZOS_RPC_URL=  TZKT_API_URL=
```

Shadownet for Tezzet, Bakingnet for TAPS — its registration asks that bakers
not be tested on Shadownet. **Ghostnet does not exist**; it is absent from
`teztnets.json`. Mainnet moves real funds and is a human decision, every time.

## Running it

```bash
npm ci
npm run verify        # constants check + typecheck + unit tests
npm run test:contract # hits the real TzKT; needs the three env vars
```

The contract test is deliberately outside `npm test`. It is the only check
that fails when TzKT removes a field, so it runs on a schedule and before a
release — and a TzKT outage must not be reported as a code failure.

## Reference

`docs/tezos-network-facts.md` in this repository. Every number here was read
from the network on 2026-08-29/30 and the document carries the call that
reproduces it. Where this package and that document disagree, the document
wins — it is reproducible.
