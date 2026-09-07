import { invoke } from '@tauri-apps/api/core';
import { HttpBackend, HttpResponseError, type HttpRequestOptions } from '@taquito/http-utils';

/**
 * Nenhuma chamada de rede sai da webview.
 *
 * A versão anterior deixava o `fetch` da janela falar direto com o nó e com a
 * TzKT, o que obrigava a CSP a ser `connect-src 'self' https:`. Com um segredo
 * do outro lado, aquela linha era o caminho de saída — foi um dos motivos da
 * reprovação do Tezos Core & Crypto em BRES-48. Agora a CSP é `'self'` e
 * quem faz a chamada é o Rust, que confere o destino contra os dois endereços
 * da configuração.
 *
 * Três consumidores, uma passagem: o cliente do nó (`HttpPayoutRpc`), o
 * cliente da TzKT (`TzKTHttp`) e o Taquito, que estima o lote. Os três já
 * aceitavam a implementação de rede por parâmetro; o que muda é só quem a
 * fornece.
 */

interface ChainReply {
  readonly status: number;
  readonly body: string;
  readonly headers: [string, string][];
}

async function call(
  url: string,
  method: 'GET' | 'POST',
  body?: string,
): Promise<ChainReply> {
  return invoke<ChainReply>('chain_request', { url, method, body: body ?? null });
}

/**
 * `fetch` para os clientes da suíte.
 *
 * Devolve um `Response` de verdade, com os cabeçalhos: o cliente da TzKT lê
 * `tzkt-level` e `tzkt-known-level` para saber o quanto o indexador está
 * atrasado, e um `Response` sem cabeçalho apagaria essa checagem sem que
 * ninguém percebesse.
 */
export const chainFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new Error(`o TAPS não usa ${method} no caminho da cadeia`);
  }
  const body = typeof init?.body === 'string' ? init.body : undefined;

  const reply = await call(url, method, body);
  return new Response(reply.body, {
    status: reply.status,
    headers: new Headers(reply.headers),
  });
};

/**
 * O backend HTTP do Taquito, pela mesma passagem.
 *
 * O Taquito só entra no caminho para uma coisa — `estimate.batch()`, que é a
 * estimativa por destinatário que a corrida em Bakingnet mostrou ser
 * obrigatória. Sem este backend, ele abriria conexão própria a partir da
 * webview e a `connect-src 'self'` o quebraria em silêncio na primeira
 * estimativa.
 */
export class TauriHttpBackend extends HttpBackend {
  override async createRequest<T>(
    options: HttpRequestOptions,
    data?: object | string,
  ): Promise<T> {
    const method = options.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(`o TAPS não usa ${method} no caminho da cadeia`);
    }
    const url = `${options.url}${this.serialize(options.query)}`;
    const body =
      data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data);

    const reply = await call(url, method, body);
    if (reply.status >= 400) {
      throw new HttpResponseError(
        `Http error response: (${reply.status}) ${reply.body}`,
        reply.status as never,
        reply.body,
        reply.body,
        url,
      );
    }
    return (options.json === false ? reply.body : JSON.parse(reply.body)) as T;
  }
}
