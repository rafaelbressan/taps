#!/usr/bin/env node
/**
 * Fails when a protocol constant is written into the source.
 *
 * The rule this enforces: a protocol constant is read from
 * /chains/main/blocks/head/context/constants at runtime, with a cache keyed
 * by (chain_id, protocol_hash), never written down. `blocks_per_cycle` is
 * 14400 on mainnet and Shadownet but 3600 on Bakingnet — a literal is wrong
 * by 4x on the TAPS testnet, silently, because nothing in a response
 * contradicts a local value.
 *
 * Usage: node scripts/check-no-protocol-constants.mjs [path ...]
 * Exit code 1 with the file, line and offending token when it finds one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Identifiers that only exist to hold a value the chain owns. */
const FORBIDDEN_IDENTIFIERS = [
  'BLOCKS_PER_CYCLE',
  'PRESERVED_CYCLES',
  'CYCLES_UNTIL_DELIVERED',
  'ENDORSERS_PER_BLOCK',
  'TIME_BETWEEN_BLOCKS',
  'DEFAULT_GAS_LIMIT',
  'DEFAULT_STORAGE_LIMIT',
  'DEFAULT_TRANSACTION_FEE',
  'DEFAULT_CONFIRMATION_BLOCKS',
  'MAX_BATCH_SIZE',
  'MAX_BATCH_OPERATIONS',
  'MIN_PAYOUT',
  'MINIMUM_PAYOUT',
  'HARD_GAS_LIMIT',
  'COST_PER_BYTE',
  'ORIGINATION_SIZE',
  'MINIMAL_STAKE',
];

/**
 * Values read from the chain on 2026-08-30. Any of them appearing as a
 * literal means somebody copied a reading into the code.
 */
const FORBIDDEN_VALUES = [
  ['4096', 'blocks_per_cycle, pre-2020'],
  ['14400', 'blocks_per_cycle on mainnet/Shadownet today'],
  ['3600', 'blocks_per_cycle on Bakingnet today'],
  ['1040000', 'hard_gas_limit_per_operation / per_block'],
  ['1_040_000', 'hard_gas_limit_per_operation / per_block'],
  ['15400', 'the old DEFAULT_GAS_LIMIT'],
  ['64250', 'origination_size * cost_per_byte — derive it, do not write it'],
  ['64_250', 'origination_size * cost_per_byte — derive it, do not write it'],
  ['7000', 'consensus_committee_size'],
  ['4667', 'consensus_threshold_size'],
  ['32768', 'max_operation_data_length'],
  ['6000000000', 'minimal_stake'],
  ['6_000_000_000', 'minimal_stake'],
];

/**
 * Not protocol constants, and allowed on purpose:
 *   1_000_000 / 1e6  — the definition of mutez, fixed by the currency
 *   1_000_000_000    — the "billionth" unit of edge_of_baking_over_staking
 *   10_000           — TzKT's documented page ceiling (an API limit)
 * Anything else on the list above has to come from the chain.
 */

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);

function collect(target, files = []) {
  const stats = statSync(target);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(target)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      collect(join(target, entry), files);
    }
  } else if (SOURCE_EXTENSIONS.has(target.slice(target.lastIndexOf('.')))) {
    files.push(target);
  }
  return files;
}

/**
 * Comments are stripped before scanning. A comment explaining that
 * `DEFAULT_GAS_LIMIT = 15400` was 7x the measured cost is documentation; the
 * check is about executable code.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) =>
      prefix + ' '.repeat(match.length - prefix.length),
    );
}

const roots = process.argv.slice(2);
const targets = (roots.length > 0 ? roots : ['src']).flatMap((root) => collect(root));

const findings = [];
for (const file of targets) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      if (new RegExp(`\\b${identifier}\\b`).test(line)) {
        findings.push({
          file,
          line: index + 1,
          token: identifier,
          why: 'protocol constants are read from the chain, not named in code',
        });
      }
    }
    for (const [value, why] of FORBIDDEN_VALUES) {
      if (new RegExp(`(?<![\\w.])${value}(?![\\w.])`).test(line)) {
        findings.push({ file, line: index + 1, token: value, why });
      }
    }
  });
}

if (findings.length > 0) {
  console.error('Protocol constants found in source:\n');
  for (const finding of findings) {
    console.error(
      `  ${relative(process.cwd(), finding.file)}:${finding.line}  ${finding.token}  — ${finding.why}`,
    );
  }
  console.error(
    `\n${findings.length} finding(s). Read the value from ` +
      '/chains/main/blocks/head/context/constants instead.',
  );
  process.exit(1);
}

console.log(`No protocol constants in ${targets.length} source file(s).`);
