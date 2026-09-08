import { useEffect, useState } from 'react';
import { buildCycleReport, type CycleReport, type DistributionStatus } from '@tezos-suite/payout';
import type { Ready } from '../App';
import { describe } from '../App';
import type { TapsSettings } from '../lib/settings';
import { statusText } from '../lib/format';
import { Address } from '../ui/Address';
import { Amount } from '../ui/Amount';
import { Empty } from '../ui/Empty';
import { Fault } from '../ui/Fault';
import { Status } from '../ui/Status';

/**
 * Os ciclos, e o relatório de um deles.
 *
 * O relatório sai de `buildCycleReport`, o mesmo do motor: quem foi pago,
 * quanto, sob qual hash, quem ficou abaixo do corte e quanto está sendo
 * carregado para o ciclo seguinte. Nada é recalculado aqui — a tela lê o que
 * foi gravado antes de a operação existir.
 */
export function Cycles({ ready, settings }: { ready: Ready; settings: TapsSettings | null }) {
  const [statuses, setStatuses] = useState<[number, DistributionStatus][] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [report, setReport] = useState<CycleReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    (async () => {
      try {
        const map = await ready.store.listCycleStatuses(settings.bakerAddress);
        const rows = [...map.entries()].sort((a, b) => b[0] - a[0]);
        if (!cancelled) {
          setStatuses(rows);
          setChosen((current) => current ?? rows[0]?.[0] ?? null);
        }
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, settings]);

  useEffect(() => {
    if (!settings || chosen === null) return;
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await ready.store.getDistribution(settings.bakerAddress, chosen);
        if (!cancelled) setReport(snapshot ? buildCycleReport(snapshot) : null);
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, settings, chosen]);

  if (!settings) {
    return (
      <>
        <h1 className="page__title">Ciclos</h1>
        <Empty
          title="Ainda não há baker configurado"
          next="Abra Configuração e diga qual endereço de baker esta instalação atende."
        />
      </>
    );
  }

  return (
    <>
      <h1 className="page__title">Ciclos</h1>
      <p className="page__lede">
        Escolha um ciclo e veja o que foi pago nele, delegador por delegador. Cada
        distribuição tem hash próprio e é gravada antes de a operação existir — é isso que
        impede pagar duas vezes.
      </p>

      {error && (
        <Fault
          what="Não consegui ler os ciclos"
          where="banco local"
          cost={`A lista abaixo pode estar incompleta. ${error}`}
        />
      )}

      {statuses !== null && statuses.length === 0 && (
        <Empty
          title="Nenhum ciclo distribuído ainda"
          next={`O agendador vai planejar o primeiro ciclo a partir do ${settings.fromCycle}, assim que ele passar da janela de denúncia.`}
        />
      )}

      {statuses !== null && statuses.length > 0 && (
        <div className="row" style={{ marginBottom: 'var(--s-6)' }}>
          <label className="t-field">
            <span className="t-field__label">Ciclo</span>
            <select
              className="t-field__input"
              value={chosen ?? ''}
              onChange={(event) => setChosen(Number(event.target.value))}
            >
              {statuses.map(([cycle, status]) => (
                <option key={cycle} value={cycle}>
                  ciclo {cycle} — {statusText(status)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {report && <Report report={report} />}
    </>
  );
}

function Report({ report }: { report: CycleReport }) {
  return (
    <div className="stack">
      <section className="t-card">
        <div className="report__head">
          <h2 className="card__title">Ciclo {report.cycle}</h2>
          <Status value={report.distributionStatus} />
        </div>
        <div className="pair">
          <span className="pair__key">Bolo do ciclo</span>
          <span className="pair__value">
            <Amount mutez={report.poolMutez} />
          </span>
        </div>
        <div className="pair">
          <span className="pair__key">Comissão do baker</span>
          <span className="pair__value">
            <Amount mutez={report.bakerFeeMutez} />
          </span>
        </div>
        <div className="pair">
          <span className="pair__key">Enviado aos delegadores</span>
          <span className="pair__value">
            <Amount mutez={report.paidMutez} />
          </span>
        </div>
        <div className="pair">
          <span className="pair__key">Abaixo do corte (K = {report.payoutFactor})</span>
          <span className="pair__value">
            {report.belowCutCount} de {report.delegatorCount}
          </span>
        </div>
        <div className="pair">
          <span className="pair__key">Dívida carregada para o próximo ciclo</span>
          <span className="pair__value">
            <Amount mutez={report.debtMutez} />
          </span>
        </div>
      </section>

      <div className="table__frame">
        <table className="table">
          <thead>
            <tr>
              <th>Delegador</th>
              <th className="num">
                Devido <span className="table__unit">ꜩ</span>
              </th>
              <th className="num">
                Pago <span className="table__unit">ꜩ</span>
              </th>
              <th className="num">
                Dívida <span className="table__unit">ꜩ</span>
              </th>
              <th>Estado</th>
              <th>Operação</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.address}>
                <td>
                  <Address value={row.address} />
                </td>
                <td className="num">
                  <Amount mutez={row.payableMutez} bare />
                </td>
                <td className="num">
                  <Amount mutez={row.paidMutez} bare />
                </td>
                <td className="num">
                  <Amount mutez={row.debtMutez} bare />
                </td>
                <td>
                  <Status value={row.status} />
                </td>
                <td>{row.opHash ? <Address value={row.opHash} /> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
