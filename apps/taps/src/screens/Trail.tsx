import { useEffect, useState } from 'react';
import type { StoredAuditEvent } from '@tezos-suite/payout';
import type { Ready } from '../App';
import { describe } from '../App';
import type { TapsSettings } from '../lib/settings';
import { actionText, outcomeText, whenText } from '../lib/format';
import { Address } from '../ui/Address';
import { Amount } from '../ui/Amount';
import { Empty } from '../ui/Empty';
import { Fault } from '../ui/Fault';

/**
 * A trilha de auditoria.
 *
 * O sistema que este substitui não tinha nenhuma: não existe tabela de
 * auditoria no schema antigo, e por isso não há como responder "quem mandou
 * pagar o ciclo 812, quando, e o que aconteceu". Aqui cada disparo, cada
 * recusa e cada parada da fila é uma linha, com quem, de onde e com que
 * parâmetros.
 */
export function Trail({ ready, settings }: { ready: Ready; settings: TapsSettings | null }) {
  const [events, setEvents] = useState<StoredAuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await ready.store.listAudit(settings.bakerAddress);
        if (!cancelled) setEvents([...rows].reverse());
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, settings]);

  if (!settings) {
    return (
      <>
        <h1 className="page__title">Trilha</h1>
        <Empty
          title="Ainda não há baker configurado"
          next="Abra Configuração e diga qual endereço de baker esta instalação atende."
        />
      </>
    );
  }

  return (
    <>
      <h1 className="page__title">Trilha</h1>
      <p className="page__lede">
        Tudo que o TAPS fez, com quem pediu e o que aconteceu. Do mais recente para o mais
        antigo.
      </p>

      {error && (
        <Fault
          what="Não consegui ler a trilha"
          where="banco local"
          cost={`A lista abaixo pode estar incompleta. ${error}`}
        />
      )}

      {events !== null && events.length === 0 && (
        <Empty
          title="Nada aconteceu ainda"
          next="A primeira linha aparece quando o agendador rodar pela primeira vez."
        />
      )}

      {events !== null && events.length > 0 && (
        <div className="table__frame">
          <table className="table">
            <thead>
              <tr>
                <th>Quando</th>
                <th className="num">Ciclo</th>
                <th>O quê</th>
                <th>Quem</th>
                <th>Resultado</th>
                <th className="num">
                  Valor <span className="table__unit">ꜩ</span>
                </th>
                <th>Operação</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{whenText(event.at)}</td>
                  <td className="num">{event.cycle === null ? '—' : event.cycle}</td>
                  <td>
                    {actionText(event.action)}
                    {/* O motivo saía só no `title`. Numa trilha de auditoria a
                        razão de uma recusa é a célula que importa, e ela não
                        pode depender de o baker passar o mouse por cima. */}
                    {event.detail && <span className="trail__detail">{event.detail}</span>}
                  </td>
                  <td>{event.actor}</td>
                  <td>{outcomeText(event.outcome)}</td>
                  <td className="num">
                    {event.amountMutez === null || event.amountMutez === undefined ? (
                      '—'
                    ) : (
                      <Amount mutez={event.amountMutez} bare />
                    )}
                  </td>
                  <td>{event.opHash ? <Address value={event.opHash} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
