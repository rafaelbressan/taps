import { Buffer } from 'buffer';

/**
 * A camada de cadeia e o motor de payout foram escritos para o Node e usam
 * `Buffer` — inclusive no caminho que monta o pedido de autenticação do
 * `octez-signer`. Numa webview `Buffer` não existe, e o que acontece é pior que
 * um erro visível: a exceção estoura fora do fluxo do clique e a tela fica
 * esperando para sempre.
 *
 * Importado no topo do `main.tsx`, antes de qualquer coisa do motor.
 */
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

if (typeof (globalThis as { global?: unknown }).global === 'undefined') {
  (globalThis as { global?: unknown }).global = globalThis;
}

export {};
