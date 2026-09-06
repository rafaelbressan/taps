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
