/**
 * Trava de rede. Este harness move dinheiro; ele só pode falar com Bakingnet.
 *
 * A trava não é configuração — é código. `ALLOWED_CHAIN_ID` é uma constante deste
 * arquivo e não é lida de env, de arquivo nem de argumento. Trocar a rede exige
 * editar e commitar este arquivo, o que aparece em revisão de código.
 *
 * O que a trava compara é o `chain_id` que a *própria cadeia* devolve, não a URL.
 * Uma URL chamada "bakingnet" apontando para mainnet reprova aqui.
 */

/** Bakingnet. Único destino permitido. */
export const ALLOWED_CHAIN_ID = 'NetXvNVUNbWHxGt';
export const ALLOWED_NETWORK_NAME = 'bakingnet';

/** Redes nomeadas explicitamente para a mensagem de erro ser útil. */
const KNOWN_CHAINS: Record<string, string> = {
  NetXdQprcVkpaWU: 'mainnet',
  NetXsqzbfFenSTS: 'shadownet',
  NetXvNVUNbWHxGt: 'bakingnet',
};

export class ForbiddenNetworkError extends Error {
  constructor(
    readonly endpoint: string,
    readonly observedChainId: string,
  ) {
    const name = KNOWN_CHAINS[observedChainId] ?? 'rede desconhecida';
    super(
      `TRAVA DE REDE: ${endpoint} respondeu chain_id ${observedChainId} (${name}). ` +
        `Este harness só opera em ${ALLOWED_NETWORK_NAME} (${ALLOWED_CHAIN_ID}). ` +
        `Mainnet é decisão humana, toda vez — nunca deste processo.`,
    );
    this.name = 'ForbiddenNetworkError';
  }
}

/** Reprova qualquer chain_id que não seja o de Bakingnet. Não há caminho de bypass. */
export function assertAllowedChainId(endpoint: string, chainId: unknown): asserts chainId is string {
  if (typeof chainId !== 'string' || chainId.length === 0) {
    throw new ForbiddenNetworkError(endpoint, String(chainId));
  }
  if (chainId !== ALLOWED_CHAIN_ID) {
    throw new ForbiddenNetworkError(endpoint, chainId);
  }
}

/**
 * Segunda barreira, independente da primeira: recusa URLs de mainnet conhecidas
 * antes mesmo de haver rede. Pega o erro de digitação sem gastar uma chamada, e
 * pega o caso em que o endpoint está fora do ar (aí a checagem de chain_id não roda).
 */
const MAINNET_HOST_MARKERS = [
  'rpc.tzbeta.net',
  'mainnet.api.tez.ie',
  'mainnet.smartpy.io',
  'mainnet.ecadinfra.com',
  'rpc.tzkt.io/mainnet',
  'api.tzkt.io',
  'mainnet-node',
];

export function assertNotMainnetUrl(kind: string, url: string): void {
  const u = url.toLowerCase();
  for (const marker of MAINNET_HOST_MARKERS) {
    if (u.includes(marker)) {
      throw new Error(
        `TRAVA DE REDE: endpoint ${kind} "${url}" é um host de mainnet conhecido. ` +
          `Este harness só opera em ${ALLOWED_NETWORK_NAME}.`,
      );
    }
  }
}
