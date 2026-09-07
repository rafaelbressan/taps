import { formatMutezAsTez } from '@tezos-suite/chain';

/**
 * A borda onde o dinheiro vira texto.
 *
 * É o único lugar do aplicativo em que um valor deixa de ser `bigint`, e ele
 * vira **string**, nunca `number`. `formatMutezAsTez` divide em inteiro; se
 * ela passasse por ponto flutuante, 0,00397 XTZ voltaria como 3969 mutez — o
 * erro que a análise mediu em 1,15% de 200 000 valores, sempre para baixo.
 */
export function xtz(mutez: bigint): string {
  return formatMutezAsTez(mutez);
}

/**
 * Endereço e hash truncam **no meio**, nunca no fim.
 *
 * O fim de um endereço Tezos é o checksum, e é a parte que uma pessoa usa para
 * conferir que colou o endereço certo. Cortar o fim tira exatamente o que
 * serve para conferir.
 */
export function middleTruncate(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function whenText(value: Date | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(value);
}

const STATUS_TEXT: Record<string, string> = {
  planned: 'planejado',
  sending: 'enviando',
  settled: 'liquidado',
  failed: 'falhou',
  blocked: 'travado',
  pending: 'aguardando',
  injected: 'injetado',
  included: 'no bloco',
  confirmed: 'confirmado',
  expired: 'expirou',
  applied: 'pago',
  deferred: 'adiado',
  paid: 'pago',
  'below-cut': 'abaixo do corte',
  zero: 'nada devido',
  unpaid: 'não pago',
  idle: 'parado',
  running: 'rodando',
  'backing-off': 'esperando para tentar de novo',
  'waiting-for-human': 'esperando você',
  stopped: 'desligado',
};

export function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

/**
 * O vocabulário da trilha, em português.
 *
 * `action` e `outcome` chegam do motor como identificadores de máquina —
 * `cycle_settled`, `queue_resumed`, `refused`. Eles atravessavam a tela como
 * estavam, e a trilha de auditoria, que é justamente a tela que o baker usa
 * para explicar um pagamento a um delegador, respondia em inglês de código.
 *
 * Uma palavra por conceito, e a mesma dos dois lados: o botão *Rodar agora*
 * produz a linha *ciclo planejado*, não *cycle_planned*.
 */
const ACTION_TEXT: Record<string, string> = {
  cycle_planned: 'ciclo planejado',
  cycle_settled: 'ciclo liquidado',
  cycle_blocked: 'ciclo travado',
  cycle_failed: 'ciclo falhou',
  cycle_skipped: 'ciclo pulado',
  batch_injected: 'lote injetado',
  batch_confirmed: 'lote confirmado',
  batch_failed: 'lote falhou',
  batch_expired: 'lote expirou',
  queue_paused: 'fila parada',
  queue_resumed: 'fila liberada',
  debt_settled: 'dívida quitada',
  settings_changed: 'configuração alterada',
  legacy_imported: 'histórico antigo importado',
};

const OUTCOME_TEXT: Record<string, string> = {
  ok: 'feito',
  refused: 'recusado',
  failed: 'falhou',
  skipped: 'pulado',
  pending: 'aguardando',
  blocked: 'travado',
};

/** O que o TAPS fez. Cai no identificador cru só se ele for novo. */
export function actionText(action: string): string {
  return ACTION_TEXT[action] ?? action.replace(/_/g, ' ');
}

/** O que aconteceu com o que ele fez. */
export function outcomeText(outcome: string): string {
  return OUTCOME_TEXT[outcome] ?? outcome;
}
