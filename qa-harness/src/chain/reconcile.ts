/**
 * Reconciliação: o que o sistema disse que ia pagar × o que a cadeia diz que foi pago.
 *
 * A comparação é **sempre** contra a cadeia. Duas fontes independentes:
 *   - TzKT (indexador), que dá remetente, destino, valor, taxa e burn por transação;
 *   - RPC (nó), que confirma que o hash está mesmo no bloco que a TzKT afirma.
 *
 * O banco do sistema nunca entra nesta conta. Um sistema que confere consigo mesmo
 * concorda consigo mesmo.
 */
import type { PayoutPlan } from '../payout/types.ts';
import type { ExecutionResult } from '../payout/types.ts';
import type { RpcClient } from './rpc.ts';
import type { TzktClient, TzktTransaction } from './tzkt.ts';

export interface AddressDiff {
  address: string;
  intended: bigint;
  onChain: bigint;
  delta: bigint;
}

export interface Reconciliation {
  ok: boolean;
  /** Endereços com diferença entre intenção e cadeia. Vazio é o único resultado bom. */
  mismatches: AddressDiff[];
  /** Pagou quem não estava no plano. */
  unexpected: AddressDiff[];
  /** Estava no plano e não recebeu nada. */
  missing: AddressDiff[];
  intendedTotal: bigint;
  onChainTotal: bigint;
  feesPaid: bigint;
  allocationFeesPaid: bigint;
  /** Hashes conferidos na RPC, não só no indexador. */
  hashesVerifiedOnRpc: string[];
  notes: string[];
}

export async function reconcile(
  plan: PayoutPlan,
  execution: ExecutionResult,
  deps: { rpc: RpcClient; tzkt: TzktClient; bakerAddress: string },
): Promise<Reconciliation> {
  const notes: string[] = [];
  const records = [...execution.injected, ...execution.skipped].filter((r) => r.opHash !== '');

  const chainTx: TzktTransaction[] = [];
  for (const r of records) {
    const txs = await deps.tzkt.transactionsByHash(r.opHash);
    if (txs.length === 0) {
      notes.push(`opHash ${r.opHash} não foi encontrado no indexador — não conclua que não pagou.`);
    }
    chainTx.push(...txs);
  }

  // Confirmação independente do indexador: o hash está no bloco que ele disse?
  const hashesVerifiedOnRpc: string[] = [];
  for (const tx of dedupeByHash(chainTx)) {
    const hashes = (await deps.rpc.operationHashes(tx.level)).flat();
    if (hashes.includes(tx.hash)) {
      hashesVerifiedOnRpc.push(tx.hash);
    } else {
      notes.push(
        `divergência entre fontes: a TzKT diz que ${tx.hash} está no nível ${tx.level}, ` +
          `a RPC não lista esse hash nesse nível.`,
      );
    }
  }

  const onChainByAddress = new Map<string, bigint>();
  let feesPaid = 0n;
  let allocationFeesPaid = 0n;

  for (const tx of chainTx) {
    if (tx.sender.address !== deps.bakerAddress) continue;
    feesPaid += BigInt(tx.bakerFee);
    allocationFeesPaid += BigInt(tx.allocationFee);
    if (tx.status !== 'applied') {
      notes.push(`transação ${tx.hash} para ${tx.target?.address ?? '?'} está ${tx.status}, não applied.`);
      continue;
    }
    const target = tx.target?.address;
    if (!target) continue;
    onChainByAddress.set(target, (onChainByAddress.get(target) ?? 0n) + BigInt(tx.amount));
  }

  const intendedByAddress = new Map<string, bigint>();
  for (const p of plan.payments) {
    if (p.amount > 0n) intendedByAddress.set(p.address, p.amount);
  }

  const mismatches: AddressDiff[] = [];
  const missing: AddressDiff[] = [];
  const unexpected: AddressDiff[] = [];

  for (const [address, intended] of intendedByAddress) {
    const onChain = onChainByAddress.get(address) ?? 0n;
    if (onChain === intended) continue;
    const diff = { address, intended, onChain, delta: onChain - intended };
    if (onChain === 0n) missing.push(diff);
    else mismatches.push(diff);
  }
  for (const [address, onChain] of onChainByAddress) {
    if (!intendedByAddress.has(address)) {
      unexpected.push({ address, intended: 0n, onChain, delta: onChain });
    }
  }

  const intendedTotal = [...intendedByAddress.values()].reduce((a, b) => a + b, 0n);
  const onChainTotal = [...onChainByAddress.values()].reduce((a, b) => a + b, 0n);

  return {
    ok: mismatches.length === 0 && missing.length === 0 && unexpected.length === 0,
    mismatches,
    unexpected,
    missing,
    intendedTotal,
    onChainTotal,
    feesPaid,
    allocationFeesPaid,
    hashesVerifiedOnRpc,
    notes,
  };
}

function dedupeByHash(txs: readonly TzktTransaction[]): TzktTransaction[] {
  const seen = new Set<string>();
  const out: TzktTransaction[] = [];
  for (const tx of txs) {
    if (seen.has(tx.hash)) continue;
    seen.add(tx.hash);
    out.push(tx);
  }
  return out;
}
