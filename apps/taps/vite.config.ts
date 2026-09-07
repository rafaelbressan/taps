import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Os três pacotes da suíte entram no bundle como FONTE, por alias.
 *
 * Não são dependências instaladas: o npm não sabe resolver uma cadeia de
 * `file:` que aponta para `file:`, e mais importante, o que se quer aqui é
 * exatamente o mesmo código que os testes do pacote exercitam — não uma cópia
 * publicada que pode divergir. `@tezos-suite/payout-store-sqlite` entra pelo
 * ponto de entrada portátil, o que não tem `node:sqlite` dentro.
 */
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * O TAPS desktop não fala HTTP com ninguém que não seja a cadeia e o signer.
 * O servidor abaixo existe só para o `tauri dev`; a porta é fixa e diferente da
 * do Tezzet para os dois poderem rodar lado a lado numa máquina de
 * desenvolvimento.
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      '@tezos-suite/chain': source('../../packages/tezos-chain/src/index.ts'),
      '@tezos-suite/payout': source('../../packages/payout-engine/src/index.ts'),
      '@tezos-suite/payout-store-sqlite': source(
        '../../packages/payout-store-sqlite/src/index.ts',
      ),
    },
  },
  server: {
    port: 1421,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
