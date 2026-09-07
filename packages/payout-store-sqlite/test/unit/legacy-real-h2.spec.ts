import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importLegacyExport } from '../../src/legacy/import';
import { parseTableColumns } from '../../src/legacy/h2-script';
import { migrate } from '../../src/migrate';
import { NodeSqliteDatabase } from '../../src/node-sqlite';
import { sha256 } from '../../src/node';

/**
 * A migração, contra bancos que o H2 escreveu.
 *
 * O outro teste de importação usa um arquivo que eu escrevi a partir do
 * `migration-docs/DATABASE_SCHEMA.md`. Ele prova que o parser entende o que eu
 * acho que o H2 emite — o que é exatamente o teste que não pode falhar.
 *
 * Estes quatro arquivos são a saída do `SCRIPT` de um H2 de verdade sobre um
 * banco criado pelo DDL do próprio TAPS em ColdFusion (`components/environment.cfc`
 * e `components/database.cfc`, no commit `6b598e78` deste repositório). Ver
 * `test/fixtures/legacy/README.md` para a receita e para o que eles acharam.
 */

const FIXTURES = join(__dirname, '..', 'fixtures', 'legacy');
const BAKER = 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb';

function load(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.sql`), 'utf8');
}

interface Shape {
  readonly name: string;
  /**
   * Σ das linhas `applied`, em mutez.
   *
   * Difere entre as duas formas de instalação, e a diferença é real: na que
   * nunca atualizou, `total` é `DECIMAL(20,2)` e o H2 arredondou 0,003970 para
   * 0,00 **em 2019**, na escrita. O importador traz o que está lá.
   */
  readonly totalPaid: bigint;
  readonly hasTransactionHash: boolean;
}

const UPGRADED: Omit<Shape, 'name'> = {
  totalPaid: 120_003_970n,
  hasTransactionHash: true,
};
const OLD: Omit<Shape, 'name'> = {
  totalPaid: 120_000_000n,
  hasTransactionHash: false,
};

const SHAPES: Shape[] = [
  { name: 'h2-1.3.172-upgraded', ...UPGRADED },
  { name: 'h2-1.4.200-upgraded', ...UPGRADED },
  { name: 'h2-1.3.172-old', ...OLD },
  { name: 'h2-1.4.200-old', ...OLD },
];

describe('importa um banco que o H2 escreveu', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = new NodeSqliteDatabase(':memory:');
    await migrate(db);
  });
  afterEach(() => db.close());

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it('traz o histórico inteiro', async () => {
        const script = load(shape.name);
        const summary = await importLegacyExport(db, script, {
          source: `${shape.name}.sql`,
          sourceSha256: sha256(script),
        });

        expect(summary.bakers).toEqual([BAKER]);
        expect(summary.cycles).toBe(2);
        expect(summary.payments).toBe(2);
        expect(summary.delegatorRows).toBe(3);
        expect(summary.customRates).toBe(2);
        expect(summary.bondMembers).toBe(2);
        expect(summary.totalPaid).toBe(shape.totalPaid);
        // `bondpoolsettings` é carregada; nada sobra sem destino.
        expect(summary.ignoredTables).toEqual([]);
      });

      it('preserva cada linha de delegador, e o hash quando ele existe', async () => {
        const script = load(shape.name);
        await importLegacyExport(db, script, {
          source: `${shape.name}.sql`,
          sourceSha256: sha256(script),
        });

        const rows = await db.query(
          'SELECT address, total, result, transaction_hash FROM legacy_delegator_payments ORDER BY address',
        );
        expect(rows).toHaveLength(3);

        const withHash = rows.filter((row) => row.transaction_hash !== null);
        // A instalação que nunca rodou `addTxHashFields()` não tem a coluna.
        // O importador precisa aceitar isso sem inventar um hash.
        expect(withHash.length).toBe(shape.hasTransactionHash ? 2 : 0);

        const failed = rows.find((row) => row.result === 'failed')!;
        expect(failed.transaction_hash).toBeNull();
      });

      it('lê a comissão individual como fração exata', async () => {
        const script = load(shape.name);
        await importLegacyExport(db, script, {
          source: `${shape.name}.sql`,
          sourceSha256: sha256(script),
        });

        const fees = await db.query(
          'SELECT fee_numerator, fee_denominator FROM legacy_delegator_fees ORDER BY address',
        );
        expect(fees).toHaveLength(2);
        expect(fees.map((row) => row.fee_numerator).sort()).toEqual([0n, 525n]);
        expect(fees.every((row) => row.fee_denominator === 10_000n)).toBe(true);
      });

      it('não carrega credencial nenhuma do banco antigo', async () => {
        const script = load(shape.name);
        // O `settings` destes bancos tem `pass_hash`, `hash_salt`, `phrase` e
        // `app_phrase` preenchidos, como no de um baker de verdade.
        expect(script).toContain('U2FsdGVkX1+segredo');

        await importLegacyExport(db, script, {
          source: `${shape.name}.sql`,
          sourceSha256: sha256(script),
        });

        const tables = (
          await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
        ).map((row) => String(row.name));
        for (const table of tables) {
          const dump = await db.query(`SELECT * FROM ${table}`);
          expect(JSON.stringify(dump, replacer)).not.toContain('segredo');
          expect(JSON.stringify(dump, replacer)).not.toContain('W4LLETH4SH');
        }
      });
    });
  }

  it('lê a ordem das colunas do CREATE quando o INSERT não a traz', () => {
    // O H2 1.4.200 escreve `INSERT INTO "PUBLIC"."PAYMENTS" VALUES (…)`, sem
    // lista de colunas. Sem isto o arquivo inteiro era recusado com
    // "não encontrei nenhum INSERT".
    const script = load('h2-1.4.200-upgraded');
    expect(script).toMatch(/INSERT INTO "PUBLIC"\."PAYMENTS" VALUES/);

    const columns = parseTableColumns(script);
    expect(columns.get('payments')).toEqual([
      'baker_id',
      'cycle',
      'date',
      'result',
      'total',
      'transaction_hash',
    ]);
    // `DECIMAL(20, 6)` tem uma vírgula dentro dos parênteses: dividir a lista
    // de colunas por vírgula sem contar profundidade inventaria uma coluna.
    expect(columns.get('delegatorspayments')).toHaveLength(7);
  });

  it('recusa um INSERT sem colunas cujo CREATE não está no arquivo', async () => {
    await expect(
      importLegacyExport(
        db,
        `INSERT INTO "PUBLIC"."PAYMENTS" VALUES ('tz1a', 1, DATE '2024-01-15', 'paid', 1.00);`,
        { source: 'sem-create.sql', sourceSha256: 'x' },
      ),
    ).rejects.toThrow(/não traz a lista de colunas/);
  });

  it('as duas formas de instalação divergem no total, e a diferença é o que o H2 perdeu', async () => {
    // Os MESMOS pagamentos, um banco com seis casas e outro com duas.
    // 3970 mutez viraram zero na escrita, em 2019. Isto está aqui para que
    // ninguém "conserte" a diferença arredondando de volta.
    expect(UPGRADED.totalPaid - OLD.totalPaid).toBe(3_970n);
  });
});

/** `JSON.stringify` não sabe serializar `bigint`. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
