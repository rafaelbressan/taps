/**
 * De onde vem o `RewardSplit` que o motor recebe.
 *
 * Duas fontes, mesmo caminho de código depois:
 *
 *  - `synthetic`: pool arbitrário rateado sobre os saldos do coorte. Serve enquanto o
 *    baker de testes ainda não completou os ciclos necessários para ter recompensa
 *    real. O **dinheiro se move de verdade** em Bakingnet mesmo assim; o que é
 *    sintético é a origem do número, não o pagamento.
 *
 *  - `tzkt`: `/v1/rewards/split/{baker}/{cycle}` do indexador da própria Bakingnet,
 *    com paginação iterada e o invariante de completude do §2.6 aplicado. É a fonte
 *    de verdade assim que o baker tiver ciclos fechados.
 *
 * Em nenhuma das duas o banco do TAPS é consultado.
 */
import type { HarnessConfig } from '../config.ts';
import { fetchJson } from '../chain/http.ts';
import type { Cohort } from '../cohort.ts';
import type { RewardSplit, SplitDelegator } from './types.ts';

/** Campos `*Delegated` — o único pool que o baker distribui à mão. */
const DELEGATED_REWARD_FIELDS = [
  'blockRewardsDelegated',
  'attestationRewardsDelegated',
  'dalAttestationRewardsDelegated',
  'vdfRevelationRewardsDelegated',
  'nonceRevelationRewardsDelegated',
] as const;

/**
 * Campos `*StakedShared`. Lidos **só** para o harness poder provar o pagamento duplicado;
 * o `|| 0` aqui é seguro porque este valor nunca entra em nenhuma conta de pagamento.
 */
const STAKED_SHARED_FIELDS = [
  'blockRewardsStakedShared',
  'attestationRewardsStakedShared',
] as const;

/**
 * Ajusta o saldo do membro `dust` para que a parte dele caia **logo abaixo** do piso.
 *
 * Sem este ajuste o cenário de poeira é frouxo dos dois lados: com pool pequeno o
 * devido dá 0 (e "não pagar zero" não prova nada), com pool grande passa do piso e o
 * caso desaparece. O alvo é metade do custo de pagar — inequivocamente poeira, e
 * inequivocamente diferente de zero.
 */
export function tuneDustBalance(split: RewardSplit, feeNum: bigint, feeDen: bigint, targetMutez: bigint): void {
  const i = indexOfDust(split);
  if (i < 0) return;

  const others = split.delegators.reduce((a, d, j) => (j === i ? a : a + d.delegatedBalance), 0n);
  const grossExternal = split.liquidPool - (split.liquidPool * split.ownDelegatedBalance) /
    (split.ownDelegatedBalance + others);
  const distributable = grossExternal - (grossExternal * feeNum) / feeDen;
  if (distributable <= targetMutez) return;

  // share = distributable * bal / (others + bal)  →  bal = target * others / (distributable - target)
  const bal = (targetMutez * others) / (distributable - targetMutez);
  split.delegators[i]!.delegatedBalance = bal > 0n ? bal : 1n;
  split.externalDelegatedBalance = split.delegators.reduce((a, d) => a + d.delegatedBalance, 0n);
}

/** O membro de poeira é o de menor saldo do coorte sintético. */
function indexOfDust(split: RewardSplit): number {
  let best = -1;
  let min = 0n;
  split.delegators.forEach((d, i) => {
    if (best < 0 || d.delegatedBalance < min) {
      best = i;
      min = d.delegatedBalance;
    }
  });
  return best;
}

export function syntheticSplit(cohort: Cohort, cycle: number, liquidPool: bigint): RewardSplit {
  const delegators: SplitDelegator[] = cohort.members
    .filter((m) => m.role !== 'staker' && BigInt(m.delegatedBalance) > 0n)
    .map((m) => ({
      address: m.address,
      delegatedBalance: BigInt(m.delegatedBalance),
      emptied: m.emptied,
    }));

  const externalDelegatedBalance = delegators.reduce((a, d) => a + d.delegatedBalance, 0n);

  return {
    cycle,
    baker: cohort.baker.address,
    liquidPool,
    blockFees: 0n,
    // O baker também tem saldo delegado próprio; ele fica com a parte dele.
    ownDelegatedBalance: externalDelegatedBalance / 20n,
    externalDelegatedBalance,
    delegators,
    delegatorsCount: delegators.length,
    // Rendimento dos stakers, já creditado pelo protocolo. Nunca entra no pool.
    stakedSharedRewards: liquidPool * 3n,
    stakers: cohort.members
      .filter((m) => m.role === 'staker')
      .map((m) => ({ address: m.address, stakedBalance: 50_000_000_000n })),
  };
}

export interface TzktSplitRaw {
  cycle: number;
  ownDelegatedBalance: number;
  externalDelegatedBalance: number;
  delegatorsCount: number;
  blockFees: number;
  delegators: { address: string; delegatedBalance: number; emptied: boolean }[];
  stakers?: { address: string; stakedBalance: number }[];
  [k: string]: unknown;
}

/**
 * Lê o split real da TzKT com paginação iterada e aborta se a lista vier truncada.
 *
 * O invariante `Σ delegators[].delegatedBalance == externalDelegatedBalance` é a única
 * checagem barata que **reprova** uma leitura incompleta. Sem ele, uma lista cortada
 * não gera erro nenhum: paga a mais para quem apareceu e zero para o resto.
 */
export async function tzktSplit(
  cfg: HarnessConfig,
  baker: string,
  cycle: number,
): Promise<RewardSplit> {
  const pageSize = 10_000;
  let head: TzktSplitRaw | undefined;
  const delegators: SplitDelegator[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const url = `${cfg.tzktUrl}/v1/rewards/split/${baker}/${cycle}?limit=${pageSize}&offset=${offset}`;
    const { status, body } = await fetchJson<TzktSplitRaw>(url, { timeoutMs: cfg.timeoutMs });
    if (status === 204 || !body) {
      throw new Error(`TzKT não tem split para ${baker} no ciclo ${cycle} (HTTP ${status}).`);
    }
    head ??= body;
    const page = body.delegators ?? [];
    for (const d of page) {
      assertField(d, 'address', baker, cycle);
      assertField(d, 'delegatedBalance', baker, cycle);
      delegators.push({
        address: d.address,
        delegatedBalance: BigInt(d.delegatedBalance),
        emptied: d.emptied === true,
      });
    }
    if (page.length < pageSize) break;
  }

  if (!head) throw new Error('resposta de split vazia.');
  for (const f of DELEGATED_REWARD_FIELDS) {
    if (head[f] === undefined) {
      throw new Error(
        `campo "${f}" ausente na resposta da TzKT para ${baker}/${cycle}. ` +
          `Não use \`|| 0\`: um campo que sumiu vira pool zero e ninguém recebe, sem erro.`,
      );
    }
  }

  const liquidPool = DELEGATED_REWARD_FIELDS.reduce((a, f) => a + BigInt(head![f] as number), 0n);
  const externalDelegatedBalance = BigInt(head.externalDelegatedBalance);
  const sum = delegators.reduce((a, d) => a + d.delegatedBalance, 0n);

  if (sum !== externalDelegatedBalance) {
    throw new Error(
      `lista de delegadores incompleta em ${baker}/${cycle}: ` +
        `Σ delegatedBalance = ${sum}, externalDelegatedBalance = ${externalDelegatedBalance} ` +
        `(faltam ${externalDelegatedBalance - sum} mutez). Abortar é o comportamento correto — ` +
        `montar o batch aqui pagaria a mais para os listados e zero para o resto.`,
    );
  }
  if (delegators.length !== head.delegatorsCount) {
    throw new Error(
      `delegatorsCount = ${head.delegatorsCount} mas foram lidos ${delegators.length} delegadores.`,
    );
  }

  return {
    cycle,
    baker,
    liquidPool,
    blockFees: BigInt(head.blockFees),
    ownDelegatedBalance: BigInt(head.ownDelegatedBalance),
    externalDelegatedBalance,
    delegators,
    delegatorsCount: head.delegatorsCount,
    stakedSharedRewards: STAKED_SHARED_FIELDS.reduce(
      (a, f) => a + BigInt((head![f] as number | undefined) ?? 0),
      0n,
    ),
    stakers: (head.stakers ?? []).map((st) => ({
      address: st.address,
      stakedBalance: BigInt(st.stakedBalance),
    })),
  };
}

function assertField(obj: object, field: string, baker: string, cycle: number): void {
  if ((obj as Record<string, unknown>)[field] === undefined) {
    throw new Error(`campo "${field}" ausente num delegador de ${baker}/${cycle}.`);
  }
}
