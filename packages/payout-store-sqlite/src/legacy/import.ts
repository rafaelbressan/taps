import { tezToMutez, type Mutez } from '@tezos-suite/chain';
import type { SqlDatabase } from '../db';
import { iso } from '../codec';
import {
  LegacyParseError,
  optionalText,
  parseH2Script,
  requireBool,
  requireInteger,
  requireNumericText,
  requireText,
  type LegacyRow,
} from './h2-script';

/**
 * Bringing the history of the old TAPS into the new database.
 *
 * Three rules, and each of them exists because the alternative loses money or
 * loses the truth about money:
 *
 * 1. **Amounts are converted through `tezToMutez` on the exported characters.**
 *    The old system stored XTZ as `DECIMAL(20,6)` and the old code turned it
 *    into mutez with `Math.floor(tez * 1e6)`, which loses one mutez on 1.15%
 *    of values, always downward. Converting from the exact digits the export
 *    wrote is what makes the imported history add up.
 * 2. **Percentages become exact rationals, never floats.** A 5.25% fee is
 *    525/10000. There is no representation of it as a `number` that survives
 *    being multiplied by a reward.
 * 3. **Nothing is merged into the new tables.** The old rows have no batch, no
 *    injection attempt and no carry-over; writing them into `distributions`
 *    would manufacture an audit trail that never existed. They keep their own
 *    tables and their own names, and the app shows them as history.
 */

export interface ImportSummary {
  readonly bakers: readonly string[];
  readonly cycles: number;
  readonly payments: number;
  readonly delegatorRows: number;
  readonly customRates: number;
  readonly bondMembers: number;
  /** Sum of every delegator line marked `applied`, in mutez. */
  readonly totalPaid: Mutez;
  readonly sourceSha256: string;
  /** Tables present in the export that this importer does not carry over. */
  readonly ignoredTables: readonly string[];
}

const CARRIED = new Set([
  'payments',
  'delegatorspayments',
  'delegatorsfee',
  'bondpool',
  'bondpoolsettings',
]);

/**
 * `settings` is read for the baker address only.
 *
 * Everything else in it is either gone (`application_port`, `client_path`,
 * `base_dir`, `node_alias` — a Lucee install that no longer exists), a
 * credential that must not survive (`pass_hash`, `hash_salt`, `wallet_hash`,
 * `wallet_salt`, `phrase`, `app_phrase`), or a protocol constant that the rules
 * now require to be read from the chain (`gas_limit`, `storage_limit`,
 * `transaction_fee`, `num_blocks_wait`).
 *
 * The encrypted passphrase columns are the sharpest case. They hold a wallet
 * encrypted with a literal salt and no authentication, and importing them
 * would carry a broken custody model into a product that decided against
 * holding the payout key at all. They are read, counted, and dropped.
 */
const SETTINGS_TABLE = 'settings';

export interface ImportOptions {
  /** Nome do arquivo, para o baker reconhecer o que importou. */
  readonly source: string;
  /**
   * SHA-256 do conteúdo, calculado por quem chamou.
   *
   * O digest entra por parâmetro em vez de ser calculado aqui porque este
   * módulo roda nos dois lados: no Node, onde `node:crypto` existe, e na
   * webview do aplicativo, onde não existe. É também o que torna
   * "este arquivo já foi importado" uma pergunta que o banco responde.
   */
  readonly sourceSha256: string;
  readonly now?: () => Date;
}

export async function importLegacyExport(
  db: SqlDatabase,
  script: string,
  options: ImportOptions,
): Promise<ImportSummary> {
  const { source, sourceSha256 } = options;
  const now = options.now ?? (() => new Date());
  const rows = parseH2Script(script);
  if (rows.length === 0) {
    throw new LegacyParseError(
      `não encontrei nenhum INSERT em ${source} — confira se o arquivo veio do comando ` +
        "SCRIPT TO 'taps-export.sql' rodado no banco antigo",
    );
  }

  const byTable = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    const bucket = byTable.get(row.table);
    if (bucket) bucket.push(row);
    else byTable.set(row.table, [row]);
  }

  const ignoredTables = [...byTable.keys()]
    .filter((table) => table !== SETTINGS_TABLE && !CARRIED.has(table))
    .sort();

  const bakers = new Set<string>();
  const cycles = new Set<string>();
  let totalPaid = 0n;

  const summary = await db.transaction(async (tx) => {
    const alreadyImported = await tx.query(
      'SELECT source, imported_at FROM legacy_import WHERE source_sha256 = ?',
      [sourceSha256],
    );
    if (alreadyImported.length > 0) {
      throw new LegacyParseError(
        `este mesmo arquivo já foi importado (${String(alreadyImported[0]!.imported_at)}) — ` +
          'importar de novo duplicaria o histórico',
      );
    }

    for (const row of byTable.get(SETTINGS_TABLE) ?? []) {
      bakers.add(requireText(row, 'baker_id'));
    }

    const payments = byTable.get('payments') ?? [];
    for (const row of payments) {
      const bakerId = requireText(row, 'baker_id');
      const cycle = requireInteger(row, 'cycle');
      bakers.add(bakerId);
      cycles.add(`${bakerId}#${cycle}`);
      await tx.execute(
        `INSERT OR REPLACE INTO legacy_payments
           (baker_id, cycle, paid_on, result, total, transaction_hash)
         VALUES (?,?,?,?,?,?)`,
        [
          bakerId,
          cycle,
          optionalText(row, 'date') ?? '',
          requireText(row, 'result'),
          xtzColumn(row, 'total'),
          optionalText(row, 'transaction_hash'),
        ],
      );
    }

    const delegatorRows = byTable.get('delegatorspayments') ?? [];
    for (const row of delegatorRows) {
      const bakerId = requireText(row, 'baker_id');
      const cycle = requireInteger(row, 'cycle');
      const result = requireText(row, 'result');
      const value = xtzColumn(row, 'total');
      bakers.add(bakerId);
      cycles.add(`${bakerId}#${cycle}`);
      if (result === 'applied') totalPaid += value;
      await tx.execute(
        `INSERT OR REPLACE INTO legacy_delegator_payments
           (baker_id, cycle, address, paid_on, result, total, transaction_hash)
         VALUES (?,?,?,?,?,?,?)`,
        [
          bakerId,
          cycle,
          requireText(row, 'address'),
          optionalText(row, 'date') ?? '',
          result,
          value,
          optionalText(row, 'transaction_hash'),
        ],
      );
    }

    const fees = byTable.get('delegatorsfee') ?? [];
    for (const row of fees) {
      const bakerId = requireText(row, 'baker_id');
      bakers.add(bakerId);
      const rate = percentToRational(requireNumericText(row, 'fee'), 'fee');
      await tx.execute(
        `INSERT OR REPLACE INTO legacy_delegator_fees
           (baker_id, address, fee_numerator, fee_denominator)
         VALUES (?,?,?,?)`,
        [bakerId, requireText(row, 'address'), rate.numerator, rate.denominator],
      );
    }

    const pool = byTable.get('bondpool') ?? [];
    for (const row of pool) {
      const bakerId = requireText(row, 'baker_id');
      bakers.add(bakerId);
      const charge = percentToRational(requireNumericText(row, 'adm_charge'), 'adm_charge');
      await tx.execute(
        `INSERT OR REPLACE INTO legacy_bond_pool
           (baker_id, address, amount, name, adm_numerator, adm_denominator, is_manager)
         VALUES (?,?,?,?,?,?,?)`,
        [
          bakerId,
          requireText(row, 'address'),
          xtzColumn(row, 'amount'),
          optionalText(row, 'name'),
          charge.numerator,
          charge.denominator,
          requireBool(row, 'is_manager', false) ? 1 : 0,
        ],
      );
    }

    await tx.execute(
      `INSERT INTO legacy_import
         (imported_at, source, source_sha256, cycles, payments, delegator_rows, total_paid)
       VALUES (?,?,?,?,?,?,?)`,
      [
        iso(now()),
        source,
        sourceSha256,
        cycles.size,
        payments.length,
        delegatorRows.length,
        totalPaid,
      ],
    );

    return {
      payments: payments.length,
      delegatorRows: delegatorRows.length,
      customRates: fees.length,
      bondMembers: pool.length,
    };
  });

  return {
    bakers: [...bakers].sort(),
    cycles: cycles.size,
    payments: summary.payments,
    delegatorRows: summary.delegatorRows,
    customRates: summary.customRates,
    bondMembers: summary.bondMembers,
    totalPaid,
    sourceSha256,
    ignoredTables,
  };
}

/** An XTZ column of the old schema, converted exactly. */
function xtzColumn(row: LegacyRow, column: string): Mutez {
  const text = requireNumericText(row, column);
  const value = tezToMutez(text);
  if (value < 0n) {
    throw new LegacyParseError(
      `a coluna ${column} da tabela ${row.table} veio negativa ("${text}") — ` +
        'o histórico do sistema antigo não deveria ter valor negativo, e importar isso ' +
        'silenciosamente esconderia um problema que existe no banco de origem',
    );
  }
  return value;
}

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * `"5.25"` (per cent) becomes 525/10000.
 *
 * The digits are read as characters. `Number("5.25") / 100` is 0.0525
 * inexactly, and that inexactness multiplies straight into a reward.
 */
export function percentToRational(text: string, column: string): Rational {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(text.trim());
  if (!match) {
    throw new LegacyParseError(
      `a coluna ${column} deveria ser uma porcentagem e veio "${text}"`,
    );
  }
  const [, whole, fraction = ''] = match;
  const numerator = BigInt(`${whole}${fraction}`);
  const denominator = 100n * 10n ** BigInt(fraction.length);
  if (numerator > denominator) {
    throw new LegacyParseError(
      `a coluna ${column} traz ${text}%, que é mais de 100% — o banco de origem está errado`,
    );
  }
  return { numerator, denominator };
}
