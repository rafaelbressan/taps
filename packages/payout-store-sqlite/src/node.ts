/**
 * A parte que só existe onde há sistema de arquivos e `node:sqlite`.
 *
 * Separada porque o aplicativo desktop empacota a metade de cima para dentro
 * da webview, e um `import 'node:sqlite'` que chegue lá quebra o build sem
 * dizer por quê.
 */
import { createHash } from 'node:crypto';

export * from './backup';
export * from './node-sqlite';
export * from './open';

/** O digest que `importLegacyExport` pede, para quem roda no Node. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
