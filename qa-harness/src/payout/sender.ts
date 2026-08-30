/**
 * O que o motor precisa de quem move o dinheiro. Existir como interface é o que permite
 * rodar os cenários de plano sem cadeia nenhuma.
 */
import type { ExecutionResult, PayoutPlan } from './types.ts';

export interface PaymentSender {
  /** Custo de pagar um destinatário: taxa + burn se a conta precisar ser alocada. */
  estimatedTransferCost(needsAllocation: boolean): bigint;
  send(plan: PayoutPlan): Promise<ExecutionResult>;
}

/**
 * Números medidos em Bakingnet em 2026-08-30, gravados para o modo offline.
 *
 * **Isto é entrada de teste, não constante de protocolo.** No caminho normal a taxa vem
 * de `estimate.batch()` e o burn de `origination_size × cost_per_byte` lidos da cadeia,
 * toda execução — é o `--offline` que troca essa leitura por um valor gravado, e ele
 * não injeta nada. Se algum dia este valor for parar num caminho que paga alguém, é bug.
 */
export const OFFLINE_FIXTURE = {
  transferFeeMutez: 488n,
  gasPerTransfer: 2169n,
  /** origination_size (257) × cost_per_byte (250). */
  allocationBurnMutez: 64_250n,
  measuredAt: '2026-08-30',
  network: 'bakingnet',
} as const;

/**
 * Move nada. Serve para rodar os cenários de plano — aritmética, completude da lista,
 * tz4, poeira, staker — sem chave, sem faucet e sem rede, que é o que cabe num CI de PR.
 */
export class OfflineSender implements PaymentSender {
  estimatedTransferCost(needsAllocation: boolean): bigint {
    return (
      OFFLINE_FIXTURE.transferFeeMutez + (needsAllocation ? OFFLINE_FIXTURE.allocationBurnMutez : 0n)
    );
  }

  send(): Promise<ExecutionResult> {
    return Promise.reject(
      new Error(
        'modo offline não injeta operação: rode sem `--offline` para mover dinheiro em Bakingnet.',
      ),
    );
  }
}
