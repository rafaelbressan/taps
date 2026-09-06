#!/usr/bin/env node
/**
 * Portão de desenho e de dinheiro.
 *
 * Três coisas reprovam, e as três já aconteceram nos sistemas herdados:
 *
 *  1. **Cor escrita à mão.** Um `#C8B08B` num arquivo do app deixa de
 *     acompanhar `suite/tokens/`, e um dia o dourado do app e o da suíte são
 *     dois dourados.
 *  2. **`border-radius` diferente de zero.** O sistema não tem canto
 *     arredondado; a exceção vira padrão em duas semanas.
 *  3. **Valor monetário tipado como `number`.** `Math.floor(0.00397 * 1e6)`
 *     dá 3969 em vez de 3970, e o erro é sistemático e sempre para baixo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['src'];

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RADIUS = /border-radius\s*:\s*([^;]+)/;
const RADIUS_PERMITIDO = new Set(['0', 'var(--radius)']);
const MONEY_AS_NUMBER = /\b\w*(mutez|amount|balance|fee|burn|saldo|valor)\w*\s*\??\s*:\s*number\b/i;

const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    check(full);
  }
}

function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_, prefix) => prefix);
}

function check(file) {
  const isCss = file.endsWith('.css');
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    const where = `${relative(appRoot, file)}:${index + 1}`;
    if (HEX.test(line)) {
      failures.push(`${where} cor escrita à mão — todo valor visual vem de suite/tokens/\n    ${line.trim()}`);
    }
    const radius = isCss ? RADIUS.exec(line) : null;
    if (radius && !RADIUS_PERMITIDO.has(radius[1].trim())) {
      failures.push(`${where} border-radius diferente de zero — o sistema não tem canto arredondado\n    ${line.trim()}`);
    }
    if (!isCss && MONEY_AS_NUMBER.test(line)) {
      failures.push(`${where} valor monetário tipado como number — mutez é bigint de ponta a ponta\n    ${line.trim()}`);
    }
  });
}

for (const root of roots) walk(join(appRoot, root));

if (failures.length > 0) {
  console.error(`portão de desenho: ${failures.length} problema(s)\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('portão de desenho: sem cor à mão, sem canto arredondado, sem dinheiro em number');
