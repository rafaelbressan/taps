import { generateKeyPairFromSeed } from '@stablelib/ed25519';
import { OpKind, TezosToolkit } from '@taquito/taquito';
import { PrefixV2, b58Encode, getPkhfromPk } from '@taquito/utils';
import BigNumber from 'bignumber.js';
import { EstimationSigner } from '../../src/chain/estimation-signer';
import type { ManagerKeySource } from '../../src/chain/rpc';
import { PayoutAccountNotRevealedError } from '../../src/errors';
import { blockHash, tz1 } from '../helpers/addresses';

/**
 * O caminho da estimativa, com o Taquito de verdade.
 *
 * O `estimation-signer.spec.ts` fixa o que a classe faz. Este arquivo fixa o
 * que o BRES-133 quebrou: o `TezosToolkit` da estimativa subia sem signer, e o
 * `NoopSigner` — o ocupante padrão daquele campo — derrubava todo ciclo com
 * "No signer has been configured", depois de a fila, o split e o plano terem
 * funcionado.
 *
 * O primeiro caso reproduz o defeito. Os outros pinam a correção e o limite
 * dela: a estimativa inteira roda, e nada assina. O nó falso é mínimo de
 * propósito — cada método aqui é um método que o Taquito realmente chama para
 * estimar um lote, e nenhum deles é de assinatura.
 */

const { publicKey } = generateKeyPairFromSeed(Buffer.alloc(32, 3));
const PAYOUT_PK = b58Encode(publicKey, PrefixV2.Ed25519PublicKey);
const PAYOUT_PKH = getPkhfromPk(PAYOUT_PK);
const BRANCH = blockHash(1);
const PROTOCOL = 'PtSeouLouXkxhg39oWEHt8ZthaWhCcQ8fRsQSAiWWugmxDZeYAK';

/** A assinatura de mentira que o Taquito manda para `run_operation`. */
const TAQUITO_STUB_SIGNATURE =
  'edsigtkpiSSschcaCt9pUVrpNPf7TTcgvgDEDD6NCEHMy8NNQJCGnMfLZzYoQj74yLjo9wx6MPVV29CvVzgi7qEcEUok3k7AuMg';

interface SimulatedOperation {
  readonly operation: {
    readonly branch: string;
    readonly contents: readonly Record<string, unknown>[];
    readonly signature: string;
  };
}

/**
 * Um nó, reduzido ao que uma estimativa pergunta.
 *
 * O `Proxy` é o ponto: qualquer método que o Taquito chame e não esteja
 * previsto aqui explode com o nome dele, em vez de devolver `undefined` e
 * fazer o teste passar por engano.
 */
function fakeNode() {
  const calls: string[] = [];
  const simulated: SimulatedOperation[] = [];
  const answers: Record<string, unknown> = {
    getConstants: {
      hard_gas_limit_per_operation: new BigNumber('900000'),
      hard_gas_limit_per_block: new BigNumber('900000'),
      hard_storage_limit_per_operation: new BigNumber('60000'),
      cost_per_byte: new BigNumber('250'),
      origination_size: 257,
      minimal_block_delay: new BigNumber('8'),
      max_operation_data_length: 32768,
    },
    getManagerKey: PAYOUT_PK,
    getBlockHash: BRANCH,
    getBlockHeader: { hash: BRANCH, level: 100 },
    getProtocols: { protocol: PROTOCOL, next_protocol: PROTOCOL },
    getContract: { counter: '10', balance: new BigNumber('1000000000') },
    getCounter: '10',
    getBalance: new BigNumber('1000000000'),
    getChainId: 'NetXdQprcVkpaWU',
    getMempoolFilter: {},
  };

  const client = new Proxy(
    {},
    {
      get(_target, method: string) {
        if (method === 'then') return undefined;
        return (...args: unknown[]) => {
          calls.push(method);
          if (method === 'simulateOperation') {
            const input = args[0] as SimulatedOperation;
            simulated.push(input);
            return Promise.resolve({
              contents: input.operation.contents.map((content) => ({
                ...content,
                metadata: {
                  operation_result: { status: 'applied', consumed_milligas: '1000000' },
                },
              })),
            });
          }
          if (method in answers) return Promise.resolve(answers[method]);
          return Promise.reject(
            new Error(`the estimation path called an unstubbed RPC method: ${method}`),
          );
        };
      },
    },
  );

  return { client, calls, simulated, answers };
}

const TRANSFER = {
  kind: OpKind.TRANSACTION as const,
  to: tz1(42),
  amount: 1_000_000,
  mutez: true,
};

describe('a estimativa do Taquito', () => {
  it('para todo ciclo quando o toolkit sobe sem signer — o defeito do BRES-133', async () => {
    const node = fakeNode();
    const toolkit = new TezosToolkit(node.client as never);

    // Exatamente a linha que o banco guardou em `queue.halted`, ciclo 384.
    await expect(toolkit.estimate.batch([TRANSFER])).rejects.toThrow(
      /No signer has been configured/,
    );
    // E antes de perguntar qualquer coisa ao nó sobre a operação.
    expect(node.simulated).toHaveLength(0);
  });

  it('completa a estimativa com o EstimationSigner, sem assinar nada', async () => {
    const node = fakeNode();
    const chain: ManagerKeySource = { getManagerKey: async () => PAYOUT_PK };
    const signer = new EstimationSigner(PAYOUT_PKH, chain);
    const sign = jest.spyOn(signer, 'sign');
    const toolkit = new TezosToolkit(node.client as never);
    toolkit.setProvider({ signer });

    const estimates = await toolkit.estimate.batch([TRANSFER]);

    expect(estimates).toHaveLength(1);
    expect(estimates[0]!.gasLimit).toBeGreaterThan(0);
    expect(sign).not.toHaveBeenCalled();
  });

  it('simula sob a assinatura de mentira do Taquito, que é por isso que ninguém precisa assinar', async () => {
    const node = fakeNode();
    const signer = new EstimationSigner(PAYOUT_PKH, {
      getManagerKey: async () => PAYOUT_PK,
    });
    const toolkit = new TezosToolkit(node.client as never);
    toolkit.setProvider({ signer });

    await toolkit.estimate.batch([TRANSFER]);

    expect(node.simulated).toHaveLength(1);
    expect(node.simulated[0]!.operation.signature).toBe(TAQUITO_STUB_SIGNATURE);
    expect(node.simulated[0]!.operation.contents).toHaveLength(1);
    // Um `reveal` na frente do lote significaria uma operação que o
    // `RpcBatchInjector` nunca forja — e a estimativa inteira errada.
    expect(node.simulated[0]!.operation.contents[0]!['kind']).toBe('transaction');
  });

  it('usa o endereço de pagamento configurado como fonte da operação', async () => {
    const node = fakeNode();
    const signer = new EstimationSigner(PAYOUT_PKH, {
      getManagerKey: async () => PAYOUT_PK,
    });
    const toolkit = new TezosToolkit(node.client as never);
    toolkit.setProvider({ signer });

    await toolkit.estimate.batch([TRANSFER]);

    expect(node.simulated[0]!.operation.contents[0]!['source']).toBe(PAYOUT_PKH);
  });

  it('recusa o ciclo quando a conta de pagamento nunca foi revelada', async () => {
    const node = fakeNode();
    const signer = new EstimationSigner(PAYOUT_PKH, { getManagerKey: async () => null });
    const toolkit = new TezosToolkit(node.client as never);
    toolkit.setProvider({ signer });

    await expect(toolkit.estimate.batch([TRANSFER])).rejects.toBeInstanceOf(
      PayoutAccountNotRevealedError,
    );
    expect(node.simulated).toHaveLength(0);
  });
});
