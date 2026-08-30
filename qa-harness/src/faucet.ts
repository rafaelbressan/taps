/**
 * Cliente do faucet do teztnets (proof-of-work, sem captcha para uso automatizado).
 *
 * O faucet é o que torna o critério "documentado como recriar o baker do zero"
 * verdadeiro em vez de aspiracional: sem ele, recriar depende de alguém ter guardado
 * uma chave com saldo.
 */
import { createHash } from 'node:crypto';
import type { HarnessConfig } from './config.ts';
import { fetchJson } from './chain/http.ts';

interface FaucetInfo {
  faucetAddress: string;
  maxBalance: number;
  minTez: number;
  maxTez: number;
}

interface ChallengeResponse {
  status: string;
  challenge?: string;
  challengeCounter?: number;
  challengesNeeded?: number;
  difficulty?: number;
  txHash?: string;
  message?: string;
}

export class Faucet {
  constructor(private readonly cfg: HarnessConfig) {}

  async info(): Promise<FaucetInfo> {
    const { body } = await fetchJson<FaucetInfo>(`${this.cfg.faucetUrl}/info`, {
      timeoutMs: this.cfg.timeoutMs,
    });
    if (!body) throw new Error('faucet não respondeu /info');
    return body;
  }

  /**
   * Pede `amountTez` para `address`. Resolve as provas de trabalho até o faucet
   * devolver o hash da transação. Devolve o `txHash`.
   */
  async fund(address: string, amountTez: number, onProgress?: (msg: string) => void): Promise<string> {
    let current = await this.#post('/challenge', { address, amount: String(amountTez) });

    // O número de desafios cresce com o valor pedido: 100 XTZ pediu 6; 20 000 pediu 834.
    // O teto vem da própria resposta, com folga — não de um número escolhido a esmo.
    const needed = current.challengesNeeded ?? 8;
    const maxRounds = needed + 16;

    for (let round = 0; round < maxRounds; round++) {
      if (current.txHash) return current.txHash;
      if (!current.challenge || current.difficulty === undefined) {
        throw new Error(`faucet devolveu resposta inesperada: ${JSON.stringify(current).slice(0, 300)}`);
      }
      const { solution, nonce } = solvePow(current.challenge, current.difficulty);
      const counter = current.challengeCounter ?? round + 1;
      if (counter === 1 || counter % 50 === 0 || counter === needed) {
        onProgress?.(`faucet: prova de trabalho ${counter}/${needed}`);
      }
      current = await this.#post('/verify', { address, solution, nonce });
    }
    throw new Error(`faucet não concluiu depois de ${maxRounds} desafios (precisava de ${needed}).`);
  }

  async #post(path: string, body: unknown): Promise<ChallengeResponse> {
    const { body: res } = await fetchJson<ChallengeResponse>(`${this.cfg.faucetUrl}${path}`, {
      timeoutMs: this.cfg.timeoutMs,
      method: 'POST',
      body,
    });
    if (!res) throw new Error(`faucet devolveu corpo vazio em ${path}`);
    if (res.status && res.status !== 'SUCCESS' && !res.txHash && !res.challenge) {
      throw new Error(`faucet recusou: ${res.message ?? res.status}`);
    }
    return res;
  }
}

/** sha256(`${challenge}:${nonce}`) com `difficulty` zeros hexadecimais à esquerda. */
export function solvePow(challenge: string, difficulty: number): { solution: string; nonce: number } {
  const prefix = '0'.repeat(difficulty);
  for (let nonce = 0; ; nonce++) {
    const hash = createHash('sha256').update(`${challenge}:${nonce}`).digest('hex');
    if (hash.startsWith(prefix)) return { solution: hash, nonce };
  }
}
