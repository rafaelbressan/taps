import { generateKeyPairFromSeed } from '@stablelib/ed25519';
import { b58Encode, PrefixV2, getPkhfromPk } from '@taquito/utils';
import { FieldTypeError, InvariantViolationError } from '@tezos-suite/chain';
import { EstimationSigner } from '../../src/chain/estimation-signer';
import { HttpPayoutRpc, type ManagerKeySource } from '../../src/chain/rpc';
import {
  EstimationSignerCannotSignError,
  PayoutAccountNotRevealedError,
} from '../../src/errors';
import { tz1 } from '../helpers/addresses';

/**
 * O signer da estimativa, BRES-133.
 *
 * O defeito que estes casos fixam não era um erro de cálculo: o
 * `TezosToolkit` da estimativa subia sem signer, o `NoopSigner` do Taquito
 * respondia "No signer has been configured" e todo ciclo parava ali. O que
 * está pinado aqui é a correção E o limite dela — este signer lê, e recusa
 * assinar.
 */

function keyPair(seed: number): { publicKey: string; publicKeyHash: string } {
  const { publicKey } = generateKeyPairFromSeed(Buffer.alloc(32, seed));
  const pk = b58Encode(publicKey, PrefixV2.Ed25519PublicKey);
  return { publicKey: pk, publicKeyHash: getPkhfromPk(pk) };
}

class FakeChain implements ManagerKeySource {
  calls: string[] = [];

  constructor(private readonly answer: string | null) {}

  async getManagerKey(address: string): Promise<string | null> {
    this.calls.push(address);
    return this.answer;
  }
}

describe('the estimation signer reads', () => {
  it('answers the configured payout address, never a discovered one', async () => {
    const { publicKeyHash } = keyPair(1);
    const signer = new EstimationSigner(publicKeyHash, new FakeChain(null));
    await expect(signer.publicKeyHash()).resolves.toBe(publicKeyHash);
  });

  it('takes the public key from the chain, not from the signer host', async () => {
    const { publicKey, publicKeyHash } = keyPair(2);
    const chain = new FakeChain(publicKey);
    const signer = new EstimationSigner(publicKeyHash, chain);

    await expect(signer.publicKey()).resolves.toBe(publicKey);
    expect(chain.calls).toEqual([publicKeyHash]);
  });

  it('reads it once, however many chunks the estimator asks for', async () => {
    const { publicKey, publicKeyHash } = keyPair(3);
    const chain = new FakeChain(publicKey);
    const signer = new EstimationSigner(publicKeyHash, chain);

    await signer.publicKey();
    await signer.publicKey();
    await signer.publicKey();

    expect(chain.calls).toHaveLength(1);
  });
});

describe('the estimation signer refuses what it must refuse', () => {
  it('stops the run when the payout account was never revealed', async () => {
    const { publicKeyHash } = keyPair(4);
    const signer = new EstimationSigner(publicKeyHash, new FakeChain(null));

    // Não é um detalhe de estimativa: uma conta sem `manager_key` não emite
    // operação nenhuma, e o injetor forja só transação — um reveal planejado
    // aqui nunca seria injetado.
    await expect(signer.publicKey()).rejects.toBeInstanceOf(PayoutAccountNotRevealedError);
  });

  it('does not cache the refusal — a reveal between runs must be seen', async () => {
    const { publicKey, publicKeyHash } = keyPair(5);
    let answer: string | null = null;
    const chain: ManagerKeySource = { getManagerKey: async () => answer };
    const signer = new EstimationSigner(publicKeyHash, chain);

    await expect(signer.publicKey()).rejects.toBeInstanceOf(PayoutAccountNotRevealedError);
    answer = publicKey;
    await expect(signer.publicKey()).resolves.toBe(publicKey);
  });

  it('refuses a manager key that belongs to another account', async () => {
    const { publicKey } = keyPair(6);
    const other = tz1(99);
    const signer = new EstimationSigner(other, new FakeChain(publicKey));

    await expect(signer.publicKey()).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it.each(['sign', 'secretKey', 'provePossession'] as const)(
    'throws on %s(): estimation is simulated, it never signs',
    async (method) => {
      const { publicKeyHash } = keyPair(7);
      const signer = new EstimationSigner(publicKeyHash, new FakeChain(null));

      await expect(signer[method]()).rejects.toBeInstanceOf(EstimationSignerCannotSignError);
    },
  );

  it('is not a PayoutSigner, so the injector cannot be handed one', () => {
    const { publicKeyHash } = keyPair(8);
    const signer = new EstimationSigner(publicKeyHash, new FakeChain(null));

    // `RpcBatchInjector` chama `signOperation`. Este objeto não tem esse
    // método — a separação das duas superfícies é do tipo, não da atenção de
    // quem liga as pontas.
    expect('signOperation' in signer).toBe(false);
  });
});

describe('manager_key, lido do nó', () => {
  const address = tz1(11);
  const path = `/chains/main/blocks/head/context/contracts/${address}/manager_key`;

  function rpcAnswering(body: string): HttpPayoutRpc {
    return new HttpPayoutRpc('https://node.example', {
      fetchImpl: (async (url: string) => {
        expect(String(url)).toBe(`https://node.example${path}`);
        return { ok: true, status: 200, text: async () => body } as Response;
      }) as unknown as typeof fetch,
    });
  }

  it('reads the public key of a revealed account', async () => {
    const { publicKey } = keyPair(12);
    await expect(rpcAnswering(JSON.stringify(publicKey)).getManagerKey(address)).resolves.toBe(
      publicKey,
    );
  });

  it('reports an unrevealed account as null, which is an answer', async () => {
    await expect(rpcAnswering('null').getManagerKey(address)).resolves.toBeNull();
  });

  it.each(['123', '{}', '""'])(
    'refuses the shape %s instead of collapsing it into "not revealed"',
    async (body) => {
      // As duas respostas levam a decisões opostas: `null` para o ciclo com um
      // recado ao operador, uma chave deixa a estimativa seguir. Uma forma
      // desconhecida não pode virar nenhuma das duas em silêncio.
      await expect(rpcAnswering(body).getManagerKey(address)).rejects.toBeInstanceOf(
        FieldTypeError,
      );
    },
  );
});
