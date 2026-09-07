#!/usr/bin/env node
/**
 * Busca `suite/` — o sistema de desenho e a narrativa da Suíte Tezos.
 *
 * Os tokens moram no repositório do Tezzet porque é de lá que vem a identidade
 * compartilhada dos dois produtos. O npm não instala subdiretório de
 * repositório git, e copiar `tokens.css` para cá criaria um segundo dourado
 * que um dia deixa de ser o mesmo.
 *
 * Então: clone raso do commit fixado em `suite.pin.json`, com sparse-checkout
 * do subdiretório, montado em `vendor/suite` — que não entra no git. O commit é
 * conferido depois do clone: um `git tag -f` no remoto não muda o que este
 * script aceita.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(readFileSync(join(appRoot, 'suite.pin.json'), 'utf8'));
const target = join(appRoot, 'vendor', 'suite');
const stamp = join(target, '.pinned-commit');

if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
  throw new Error(
    `suite.pin.json: "commit" precisa ser um SHA de 40 dígitos, veio ${JSON.stringify(pin.commit)} — ` +
      'um branch move e deixa de ser um pino',
  );
}

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === pin.commit) {
  process.stdout.write(`suite já em ${pin.commit.slice(0, 12)}\n`);
  process.exit(0);
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

const work = mkdtempSync(join(tmpdir(), 'tezos-suite-'));
try {
  git(['init', '--quiet', work]);
  git(['remote', 'add', 'origin', pin.repository], work);
  git(['config', 'core.sparseCheckout', 'true'], work);
  mkdirSync(join(work, '.git', 'info'), { recursive: true });
  writeFileSync(join(work, '.git', 'info', 'sparse-checkout'), `${pin.subdirectory}/\n`);
  git(['fetch', '--quiet', '--depth', '1', 'origin', pin.commit], work);
  git(['checkout', '--quiet', 'FETCH_HEAD'], work);

  const fetched = git(['rev-parse', 'HEAD'], work);
  if (fetched !== pin.commit) {
    throw new Error(`commit conferido ${fetched} não é o fixado ${pin.commit}`);
  }

  const source = join(work, pin.subdirectory);
  if (!existsSync(join(source, pin.marker))) {
    throw new Error(`${pin.subdirectory}/${pin.marker} não existe em ${pin.commit}`);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  writeFileSync(stamp, `${pin.commit}\n`);
  process.stdout.write(`suite @ ${pin.commit.slice(0, 12)} → vendor/suite\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
