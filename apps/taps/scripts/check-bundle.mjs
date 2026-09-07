#!/usr/bin/env node
/**
 * O bundle não pode carregar um módulo do Node.
 *
 * O motor de payout foi escrito para o Node e traz consigo coisas que só
 * existem lá — `FilePayoutStore` usa `node:fs`, e o driver Node do banco usa
 * `node:sqlite`. Nenhum dos dois é usado por este aplicativo, e hoje o
 * empacotador os remove por não serem alcançáveis.
 *
 * "Hoje" é o problema. Um `import` novo em qualquer arquivo pode trazer um
 * deles de volta, e o efeito é uma janela que abre em branco: o módulo estoura
 * no carregamento, antes de qualquer tela existir, e nenhum teste de unidade vê
 * isso. Este portão roda depois do build e olha o que de fato foi gerado.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(appRoot, 'dist', 'assets');

const FORBIDDEN = /(^|["'`\s(])node:(fs|path|crypto|sqlite|os|child_process|net|tls|https|http)\b/;

const findings = [];
for (const entry of readdirSync(assets)) {
  if (!entry.endsWith('.js')) continue;
  const source = readFileSync(join(assets, entry), 'utf8');
  const match = FORBIDDEN.exec(source);
  if (match) findings.push(`${entry}: ${match[0].trim()}`);
}

if (findings.length > 0) {
  console.error('módulo do Node dentro do bundle da webview:\n');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    '\nNa webview isso estoura no carregamento e a janela abre em branco. ' +
      'Importe do ponto de entrada portátil do pacote, não do que é só do Node.',
  );
  process.exit(1);
}

console.log('bundle: nenhum módulo do Node alcançável a partir da webview');
