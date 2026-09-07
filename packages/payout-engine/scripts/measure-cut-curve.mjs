#!/usr/bin/env node
/**
 * Measures the cut curve of RN-24 for one baker and one cycle.
 *
 * K — how many times the estimated transfer cost a payment must cover to
 * enter the batch — is the one number the baker has to choose, and it is a
 * trade with two sides: less of the pool lost to network fees, against a
 * longer wait for the small delegator. Neither side is guessable from
 * outside, because both depend on how that baker's delegated balance is
 * distributed. So it is measured, on their own pool, rather than argued.
 *
 * Reads only. Nothing here signs, injects or writes.
 *
 * Usage:
 *   node scripts/measure-cut-curve.mjs <baker> <cycle> [options]
 *
 *   --fee <mutez>       estimated cost of one transfer. Default 477, the
 *                       measured median of 5957 tz->tz mainnet transfers on
 *                       2026-08-30 (mean 543, p90 554). Use your own: take it
 *                       from `estimate.batch()` on the day you decide.
 *   --fee-num <n>       baker commission numerator. Default 10.
 *   --fee-den <n>       baker commission denominator. Default 100.
 *   --tzkt <url>        TzKT API base. Default https://api.tzkt.io.
 *   --block-fees        include block fees in the pool.
 *
 * Example — the reference baker of BRES-38:
 *   node scripts/measure-cut-curve.mjs tz1fwnfJNgiDACshK9avfRfFbMaXrs3ghoJa 1336
 */

const FIELDS = [
  'blockRewards',
  'attestationRewards',
  'dalAttestationRewards',
  'vdfRevelationRewards',
  'nonceRevelationRewards',
];

/** The Ks worth looking at. 0 is "no cut", for the baseline. */
const FACTORS = [
  [0n, 1n],
  [1n, 1n],
  [3n, 2n],
  [2n, 1n],
  [3n, 1n],
  [4n, 1n],
  [5n, 1n],
  [10n, 1n],
];

function parseArgs(argv) {
  const [baker, cycle] = argv.filter((a) => !a.startsWith('--'));
  if (!baker || !cycle) {
    console.error('usage: measure-cut-curve.mjs <baker> <cycle> [--fee 477] [--fee-num 10] [--fee-den 100]');
    process.exit(2);
  }
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  return {
    baker,
    cycle,
    feeMutez: BigInt(flag('fee', '477')),
    feeNum: BigInt(flag('fee-num', '10')),
    feeDen: BigInt(flag('fee-den', '100')),
    tzkt: flag('tzkt', 'https://api.tzkt.io'),
    includeBlockFees: argv.includes('--block-fees'),
  };
}

/**
 * `?limit=10000` is not decoration. Without it TzKT returns the first 100
 * delegators and says nothing about the rest — a baker with 2919 of them
 * would be split as if they had 100, and nobody would be told.
 */
async function loadSplit({ tzkt, baker, cycle }) {
  const url = `${tzkt}/v1/rewards/split/${baker}/${cycle}?limit=10000`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  const split = await response.json();
  if (split.delegators.length !== split.delegatorsCount) {
    throw new Error(
      `truncated delegator list: ${split.delegators.length} of ${split.delegatorsCount} — ` +
        'every number below would be wrong and none of them would look it',
    );
  }
  return split;
}

/** The same arithmetic as `computePayout`: bigint, integer division, no float. */
function plan(split, { feeNum, feeDen, includeBlockFees }) {
  const big = (v) => BigInt(v ?? 0);
  // Only the *Delegated fields land on the baker's liquid balance.
  // `endorsementRewardsDelegated` is TzKT's legacy alias of
  // `attestationRewardsDelegated`; summing both would count it twice.
  let pool = FIELDS.reduce((sum, field) => sum + big(split[`${field}Delegated`]), 0n);
  if (includeBlockFees) pool += big(split.blockFees);

  const own = big(split.ownDelegatedBalance);
  const external = big(split.externalDelegatedBalance);
  const ownShare = (pool * own) / (own + external);
  const externalGross = pool - ownShare;
  const bakerFee = (externalGross * feeNum) / feeDen;
  const distributable = externalGross - bakerFee;

  const owed = split.delegators.map(
    (d) => (distributable * big(d.delegatedBalance)) / external,
  );
  return { pool, ownShare, bakerFee, distributable, owed };
}

const ceilDiv = (a, b) => (a + b - 1n) / b;
/**
 * Percent with two decimals, from integers, rounded half-up. The only place a
 * float appears, and only to place the decimal point: truncating here would
 * print 4,49 where every earlier measurement of the same number says 4,50.
 */
const percent = (part, whole) =>
  (Number((part * 10_000n + whole / 2n) / whole) / 100).toFixed(2);

const options = parseArgs(process.argv.slice(2));
const split = await loadSplit(options);
const { pool, ownShare, bakerFee, distributable, owed } = plan(split, options);

console.log(`${options.baker} cycle ${options.cycle}`);
console.log(
  `  pool ${pool} | own ${ownShare} | commission ${bakerFee} | distributable ${distributable}`,
);
console.log(
  `  ${owed.length} delegators | transfer cost ${options.feeMutez} mutez | ` +
    `commission ${options.feeNum}/${options.feeDen}\n`,
);

console.log('| K | cut | paid | fees | % of pool | accumulates | median wait below the cut |');
console.log('|---:|---:|---:|---:|---:|---:|---:|');
for (const [numerator, denominator] of FACTORS) {
  const cut = ceilDiv(options.feeMutez * numerator, denominator);
  const paid = owed.filter((amount) => amount > 0n && amount > cut);
  const below = owed.filter((amount) => amount > 0n && amount <= cut);
  const fees = BigInt(paid.length) * options.feeMutez;
  const carried = below.reduce((sum, amount) => sum + amount, 0n);

  // How many cycles someone below the cut waits to clear it, if their share
  // per cycle does not change. The median of those left out — the number the
  // baker is actually spending when they raise K.
  const waits = below.map((amount) => Number(cut / amount) + 1).sort((a, b) => a - b);
  const medianWait = waits.length > 0 ? waits[Math.floor(waits.length / 2)] : 0;

  const k = denominator === 1n ? `${numerator}` : `${numerator}/${denominator}`;
  console.log(
    `| ${k} | ${cut} | ${paid.length} | ${fees} | ${percent(fees, distributable)} % | ` +
      `${carried} | ${medianWait} cycles |`,
  );
}

console.log(
  '\nA cycle is `blocks_per_cycle * minimal_block_delay` — 24h on mainnet today, so a ' +
    'cycle of waiting is a day of waiting. Read it from the chain, never from here.',
);
