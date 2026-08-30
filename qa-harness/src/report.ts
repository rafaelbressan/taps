/**
 * Diagnóstico legível. A regra é: quem lê descobre o que reprovou e por quê sem
 * abrir arquivo nenhum — e não precisa rolar um dump para chegar lá.
 */
import type { RunReport } from './run.ts';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

export function renderReport(r: RunReport, useColor = process.stdout.isTTY): string {
  const c = (code: string, s: string) => (useColor ? `${code}${s}${OFF}` : s);
  const L: string[] = [];

  L.push('');
  L.push(c(BOLD, `Harness de payout — ${r.dryRun ? 'ensaio (nada injetado)' : 'execução na cadeia'}`));
  L.push(
    c(DIM, `bakingnet ${r.network.chainId} · ciclo ${r.network.cycle} · nível ${r.network.level} · baker ${r.baker}`),
  );
  if (r.mutants.length > 0) {
    L.push(c(RED, `mutantes ativos: ${r.mutants.join(', ')} — esta rodada DEVE reprovar`));
  }
  L.push('');

  L.push(c(BOLD, 'Plano'));
  L.push(
    `  ${r.plan.recipients} a pagar · ${r.plan.belowFloor} abaixo do piso · ` +
      `${fmt(r.plan.totalToSendMutez)} a enviar`,
  );
  L.push(
    c(DIM, `  parte do baker ${fmt(r.plan.ownShareMutez)} · taxa ${fmt(r.plan.bakerFeeMutez)} · sobra ${r.plan.dustMutez} mutez`),
  );
  L.push(
    c(DIM, `  piso derivado da rede: taxa ${r.calibration.transferFeeMutez} mutez, gas ${r.calibration.gasPerTransfer}, ` +
      `burn de alocação ${r.calibration.allocationBurnMutez} mutez`),
  );
  L.push('');

  if (!r.dryRun) {
    L.push(c(BOLD, 'Cadeia'));
    L.push(`  intenção ${fmt(r.onChain.intendedTotalMutez)} · pago ${fmt(r.onChain.onChainTotalMutez)}`);
    L.push(
      c(DIM, `  taxas ${r.onChain.feesPaidMutez} + alocação ${r.onChain.allocationFeesPaidMutez} mutez`),
    );
    for (const h of r.onChain.injectedOps) L.push(c(DIM, `  op ${h}`));
    if (r.onChain.secondRunInjectedOps.length > 0) {
      L.push(c(RED, `  2ª execução injetou: ${r.onChain.secondRunInjectedOps.join(', ')}`));
    }
    L.push(
      c(DIM, `  ${r.onChain.hashesVerifiedOnRpc.length} hash(es) confirmado(s) também pela RPC (fonte independente do indexador)`),
    );
    for (const n of r.onChain.notes) L.push(c(DIM, `  nota: ${n}`));
    L.push('');
  }

  L.push(c(BOLD, 'Cenários'));
  for (const s of r.scenarios) {
    const mark = s.ok ? c(GREEN, 'passa ') : c(RED, 'REPROVA');
    L.push(`  ${mark} ${s.name}`);
    for (const line of s.evidence.split('\n')) L.push(c(DIM, `          ${line}`));
  }
  L.push('');

  const failed = r.scenarios.filter((s) => !s.ok);
  if (r.passed) {
    L.push(c(GREEN, `${r.scenarios.length} cenários, nenhum reprovado.`));
  } else {
    L.push(c(RED, `${failed.length} de ${r.scenarios.length} cenários reprovaram: ${failed.map((s) => s.name).join(', ')}`));
  }
  L.push('');
  return L.join('\n');
}

/** mutez com separador, e XTZ entre parênteses quando o número é grande o bastante. */
function fmt(mutez: string): string {
  const n = BigInt(mutez);
  const grouped = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (n >= 1_000_000n) {
    const xtz = Number(n) / 1e6;
    return `${grouped} mutez (${xtz.toFixed(6)} XTZ)`;
  }
  return `${grouped} mutez`;
}
