#!/usr/bin/env node
/**
 * Fails when the payout path grows a way to hold a signing key.
 *
 * Custody decision of 2026-08-28 (option A): the TAPS backend does not store,
 * derive or carry the payout key — no database column, no file, no
 * environment variable. Reintroducing any of the three is an automatic
 * rejection, so it is checked by a script rather than by whoever reviews.
 *
 * The signer's CLIENT credential is allowed and is not this: it proves who is
 * asking, signs nothing on chain, and moves no money on its own.
 *
 * Usage: node scripts/check-no-local-key.mjs [path ...]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RULES = [
  { pattern: /\bInMemorySigner\b/, why: 'a signer that holds the secret key in the process' },
  { pattern: /@taquito\/signer/, why: 'the local-key signer package' },
  { pattern: /\bimportKey\s*\(/, why: 'Taquito key import puts a secret in the process' },
  { pattern: /\bsetSignerProvider\s*\(/, why: 'installs a local signer on the toolkit' },
  { pattern: /\bmnemonic\b/i, why: 'a mnemonic is a key' },
  { pattern: /\bencrypted_?passphrase\b/i, why: 'the legacy wallet passphrase column' },
  { pattern: /\bwallet_?(hash|salt)\b/i, why: 'the legacy wallet key material columns' },
  { pattern: /\bPAYOUT_(PRIVATE|SECRET)_KEY\b/, why: 'a payout key in the environment' },
  { pattern: /\bTEZOS_(PRIVATE|SECRET)_KEY\b/, why: 'a payout key in the environment' },
  { pattern: /\bpasswordFilename|--password-filename/, why: 'unattended signer unlock recreates the defect option A removes' },
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
  console.error('Local signing key material found in source:\n');
  for (const finding of findings) {
    console.error(
      `  ${relative(process.cwd(), finding.file)}:${finding.line}  ${finding.token}  — ${finding.why}`,
    );
  }
  console.error(
    `\n${findings.length} finding(s). Signing happens on the octez-signer host, never here.`,
  );
  process.exit(1);
}

console.log(`No local key material in ${targets.length} source file(s).`);
