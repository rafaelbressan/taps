import { auditColumns } from '../../src/engine';

/**
 * As colunas VALOR e OPERAÇÃO da Trilha, e o motivo do erro.
 *
 * Elas existiam na tabela e ninguém as preenchia. Numa Debian de verdade a
 * Trilha mostrou `signature.requested` com "—" em VALOR, numa linha que
 * carregava 43 564 728 mutez em `params`, e `queue.halted` sem nenhum motivo
 * visível — o motivo estava no JSON, que o baker não abre (BRES-110).
 */
describe('auditColumns', () => {
  it('takes the total the signature was asked for', () => {
    expect(
      auditColumns({
        batch: 0,
        destinations: ['tz1WBDD8994HUbgaD8N8WB5eqdq35TErQAjY'],
        totalAmountMutez: '43564728',
        totalFeesMutez: '493',
      }),
    ).toEqual({
      amountMutez: 43564728n,
      destinations: ['tz1WBDD8994HUbgaD8N8WB5eqdq35TErQAjY'],
    });
  });

  it('surfaces the reason a run halted', () => {
    expect(auditColumns({ reason: 'não consegui falar com o octez-signer' })).toEqual({
      detail: 'não consegui falar com o octez-signer',
    });
  });

  it('keeps the operation hash when there is one', () => {
    expect(auditColumns({ opHash: 'ooBuwjbxQQ52A24scz87xErxjMAUMYvK4TUvoSnZk3soM8jTDLa' })).toEqual({
      opHash: 'ooBuwjbxQQ52A24scz87xErxjMAUMYvK4TUvoSnZk3soM8jTDLa',
    });
  });

  it('leaves a column out rather than inventing a value', () => {
    // Dinheiro não vira zero por falta de dado: a coluna some.
    expect(auditColumns({ fromCycle: 384, headCycle: 386 })).toEqual({});
    expect(auditColumns({ totalAmountMutez: 'quase nada' })).toEqual({});
    expect(auditColumns({ destinations: ['tz1…', 7] })).toEqual({});
  });

  it('accepts a bigint as readily as its string', () => {
    expect(auditColumns({ totalAmountMutez: 43564728n }).amountMutez).toBe(43564728n);
  });
});
