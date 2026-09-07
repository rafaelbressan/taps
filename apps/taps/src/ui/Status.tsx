import { statusText } from '../lib/format';

const TONE: Record<string, string> = {
  settled: 't-status--paid',
  confirmed: 't-status--paid',
  applied: 't-status--paid',
  planned: 't-status--pending',
  sending: 't-status--pending',
  pending: 't-status--pending',
  injected: 't-status--pending',
  included: 't-status--pending',
  deferred: 't-status--simulated',
  paid: 't-status--paid',
  'below-cut': 't-status--simulated',
  zero: 't-status--simulated',
  unpaid: 't-status--pending',
  failed: 't-status--failed',
  blocked: 't-status--failed',
  expired: 't-status--failed',
};

/** O texto carrega o significado; a cor apenas reforça. */
export function Status({ value }: { value: string }) {
  return <span className={`t-status ${TONE[value] ?? 't-status--simulated'}`}>{statusText(value)}</span>;
}
