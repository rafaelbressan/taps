import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A fronteira, como teste.
 *
 * A primeira versão deste aplicativo afirmava, no `capabilities/default.json`,
 * que seus comandos "não aceitam caminho nem endereço arbitrário vindo da
 * tela". Aceitavam. O Tezos Core & Crypto reprovou (BRES-48), e a lição não é
 * "escrever a afirmação com mais cuidado" — é que uma afirmação sobre a
 * fronteira precisa de um teste, senão ela envelhece sozinha.
 *
 * Cada caso aqui é uma das quatro portas que estavam abertas.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
  }
  return found;
}

/** Comentário é documentação; o portão é sobre código que roda. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const files = sources(join(appRoot, 'src'));

describe('a credencial do signer não atravessa para a janela', () => {
  it('não existe comando que devolva a credencial', () => {
    for (const file of files) {
      expect(code(file)).not.toMatch(/signer_reveal_credential|revealClientAuthKey/);
    }
  });

  it('a janela nunca constrói um autenticador com uma chave em mãos', () => {
    // `Ed25519ClientAuthenticator` recebe o `edsk` no construtor. Ele é o
    // caminho certo para um processo Node — e o errado para esta webview.
    for (const file of files) {
      expect(code(file)).not.toMatch(/new\s+Ed25519ClientAuthenticator/);
    }
  });

  it('nenhuma tela pede a chave por campo de texto', () => {
    // Requisito 9 da ADR-0001. O segredo entra por arquivo, escolhido pelo Rust.
    for (const file of files) {
      expect(code(file)).not.toMatch(/type=\{?['"]password['"]/);
    }
  });
});

describe('a janela não escolhe destino de rede', () => {
  it('só `chain-http.ts` fala de rede, e ele fala com o Rust', () => {
    for (const file of files) {
      if (file.endsWith('chain-http.ts')) continue;
      // `chainFetch` é a passagem; `fetch(` cru é uma saída própria.
      expect(code(file)).not.toMatch(/(^|[^.\w])fetch\s*\(/);
    }
  });

  it('a CSP não deixa a janela abrir conexão para lugar nenhum', () => {
    const config = JSON.parse(
      readFileSync(join(appRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { security: { csp: string } } };
    expect(config.app.security.csp).toContain("connect-src 'self'");
    expect(config.app.security.csp).not.toMatch(/connect-src[^;]*https:/);
  });

  it('o endereço do signer não vai como parâmetro do comando', () => {
    const runtime = code(join(appRoot, 'src/lib/runtime.ts'));
    const call = /invoke<[^>]*>\('signer_call',\s*\{([^}]*)\}/.exec(runtime);
    expect(call, 'a chamada ao signer mudou de forma').not.toBeNull();
    expect(call![1]).not.toContain('url');
  });

  it('a janela também não escolhe em quem o canal do signer confia', () => {
    // BRES-137: o certificado que o TAPS aceita do signer é lido pelo Rust,
    // da mesma configuração de onde sai o endereço. Se ele passasse como
    // parâmetro, "a tela não escolhe destino" valeria para o endereço e não
    // para a confiança — que é a metade que decide se o destino é o certo.
    const runtime = code(join(appRoot, 'src/lib/runtime.ts'));
    const call = /invoke<[^>]*>\('signer_call',\s*\{([^}]*)\}/.exec(runtime);
    expect(call![1]).not.toMatch(/\b(ca|cert|certificate|pem)\b/i);
  });
});

describe('a confirmação é da tela, não do navegador', () => {
  it('nenhuma pergunta destrutiva sai por `window.confirm`', () => {
    // BRES-124: a confirmação da restauração era um `window.confirm`. Na
    // webview do Linux nenhuma janela apareceu e o banco foi trocado assim
    // mesmo — duas vezes. Um diálogo que o aplicativo não desenha é um
    // diálogo que ele não consegue garantir nem testar.
    for (const file of files) {
      expect(code(file), file).not.toMatch(/\bwindow\.(confirm|alert|prompt)\s*\(/);
    }
  });
});

describe('a janela não escolhe arquivo', () => {
  it('o plugin de diálogo não é chamado do lado do JavaScript', () => {
    for (const file of files) {
      expect(code(file)).not.toContain('@tauri-apps/plugin-dialog');
    }
  });

  it('a permissão do diálogo não está na capacidade da janela', () => {
    const capability = JSON.parse(
      readFileSync(join(appRoot, 'src-tauri/capabilities/default.json'), 'utf8'),
    ) as { permissions: string[] };
    expect(capability.permissions.filter((entry) => entry.startsWith('dialog:'))).toEqual([]);
  });

  it('nenhum comando de arquivo recebe caminho', () => {
    const withPath = /invoke<[^>]*>\('(read_legacy_export|inspect_database|restore_backup|backup_into|signer_import_credential|signer_import_certificate)',\s*\{([^}]*)\}/g;
    for (const file of files) {
      const source = code(file);
      for (const match of source.matchAll(withPath)) {
        expect(match[2], `${match[1]} em ${file}`).not.toMatch(/\bpath\b/);
        expect(match[2], `${match[1]} em ${file}`).toContain('token');
      }
    }
  });
});
