#!/usr/bin/env node
/**
 * Fails when a monetary value is carried by a `number`.
 *
 * Why this is a build gate and not a review habit: `tezToMutez` in the
 * current TAPS is `Math.floor(tez * 1e6)`. Over 200 000 measured values,
 * 2309 of them (1.15%) lose one mutez, always downward — 0.00397 becomes
 * 3969. Nothing raises, nothing is logged, and the shortfall is systematic
 * rather than random, so it never cancels out across a distribution.
 *
 * Usage: node scripts/check-no-number-money.mjs [path ...]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Words that mark a value as money. Case-insensitive. */
const MONEY_WORDS =
  'mutez|amount|fee|balance|reward|payable|gross|commission|total|burn|payout|carried|carryover|withheld|minimum|dust|remainder|share|pool';

const RULES = [
  {
    pattern: new RegExp(`\\b(\\w*(?:${MONEY_WORDS})\\w*)\\s*\\??\\s*:\\s*number\\b`, 'i'),
    why: 'a monetary field typed as number — mutez is bigint from end to end',
  },
  {
    pattern: /\bMath\.(floor|round|ceil|abs|trunc)\s*\(/,
    why: 'floating point arithmetic; integer division on bigint does not need it',
  },
  {
    pattern: /\b(parseFloat|toFixed)\s*\(/,
    why: 'a float parser or formatter in a package where XTZ only exists as a string',
  },
  {
    pattern: /(?<![\w.])1e6(?![\w.])/,
    why: 'scaling by 1e6 in floating point is exactly how tezToMutez loses a mutez',
  },
  {
    pattern: new RegExp(`\\bNumber\\s*\\(\\s*\\w*(?:${MONEY_WORDS})\\w*`, 'i'),
    why: 'a monetary value crossing into number',
  },
];

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

/** Comments are documentation; the check is about executable code. */
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
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match) findings.push({ file, line: index + 1, token: match[0].trim(), why: rule.why });
    }
  });
}

if (findings.length > 0) {
  console.error('number found in the money path:\n');
  for (const finding of findings) {
    console.error(
      `  ${relative(process.cwd(), finding.file)}:${finding.line}  ${finding.token}  — ${finding.why}`,
    );
  }
  console.error(`\n${findings.length} finding(s). Money is bigint mutez; XTZ is a display string.`);
  process.exit(1);
}

console.log(`No number in the money path across ${targets.length} source file(s).`);
