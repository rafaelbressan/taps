import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  explainEmptyScript,
  findInsertStatements,
  LegacyParseError,
  parseH2Script,
} from '../../src/legacy/h2-script';
import { importLegacyExport } from '../../src/legacy/import';
import { migrate } from '../../src/migrate';
import { NodeSqliteDatabase } from '../../src/node-sqlite';
import { sha256 } from '../../src/node';

/**
 * O arquivo que a Migração recusou (BRES-125), e o que ela dizia ao recusá-lo.
 *
 * `bres-125-taps-export.sql` é o anexo do relato, byte por byte: um baker
 * seguiu o `MIGRACAO-DA-VERSAO-ANTIGA.md`, rodou
 * `SCRIPT TO 'taps-export.sql'` num H2 1.4.200 e recebeu de volta
 * *"não encontrei nenhum INSERT"* sobre um arquivo com seis. Ele está aqui
 * inteiro — 28 colunas em `settings`, `bondPoolSettings`, aspas, `PUBLIC`,
 * espaço em branco no fim das linhas — porque uma versão reduzida dele seria
 * de novo a minha leitura do formato, não o formato.
 *
 * Os dois defeitos que o relato separa têm um teste cada:
 *
 * 1. o parser precisa ler o que o `SCRIPT TO` emite;
 * 2. quando ele não lê, a frase precisa dizer a verdade sobre o arquivo.
 */

const FIXTURE = join(__dirname, '..', 'fixtures', 'legacy', 'bres-125-taps-export.sql');
const BAKER = 'tz1VQnqCCqX4K5sP3FNkVSNKTdCAMJDd3E1n';

const SCRIPT = readFileSync(FIXTURE, 'utf8');

describe('o taps-export.sql do relato', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = new NodeSqliteDatabase(':memory:');
    await migrate(db);
  });
  afterEach(() => db.close());

  it('é mesmo a saída do SCRIPT TO, com tudo que ela tem de incômodo', () => {
    // Se alguém "arrumar" a fixture, os testes abaixo param de provar o que
    // provam. Estas três formas são o defeito.
    expect(SCRIPT).toContain('INSERT INTO "PUBLIC"."PAYMENTS" VALUES\n(');
    expect(SCRIPT).toMatch(/^\);[ \t]+$/mu);
    expect(SCRIPT.split('\n').filter((line) => line.startsWith('(')).length).toBeGreaterThan(6);
    expect(findInsertStatements(SCRIPT)).toHaveLength(6);
  });

  it('traz as 16 linhas das seis tabelas', () => {
    const counts = new Map<string, number>();
    for (const row of parseH2Script(SCRIPT)) {
      counts.set(row.table, (counts.get(row.table) ?? 0) + 1);
    }
    expect([...counts.entries()].sort()).toEqual([
      ['bondpool', 2],
      ['bondpoolsettings', 1],
      ['delegatorsfee', 2],
      ['delegatorspayments', 6],
      ['payments', 4],
      ['settings', 1],
    ]);
  });

  it('importa o histórico inteiro, com os centavos que o guia promete', async () => {
    const summary = await importLegacyExport(db, SCRIPT, {
      source: 'taps-export.sql',
      sourceSha256: sha256(SCRIPT),
    });

    expect(summary.bakers).toEqual([BAKER]);
    expect(summary.cycles).toBe(4);
    expect(summary.payments).toBe(4);
    expect(summary.delegatorRows).toBe(6);
    expect(summary.customRates).toBe(2);
    expect(summary.bondMembers).toBe(2);
    expect(summary.ignoredTables).toEqual([]);
    // 60,123456 + 65,419754 + 50 + 48,100001 + 40,000250 + 37,000250.
    expect(summary.totalPaid).toBe(300_643_711n);

    // 125.543210 ꜩ: o valor onde o `Math.floor(tez * 1e6)` do sistema antigo
    // devolvia um mutez a menos.
    const payments = await db.query('SELECT cycle, total FROM legacy_payments ORDER BY cycle');
    expect(payments.map((row) => row.total)).toEqual([
      125_543_210n,
      98_100_001n,
      77_000_500n,
      0n,
    ]);
  });

  it('lê as duas comissões individuais como frações exatas', async () => {
    await importLegacyExport(db, SCRIPT, {
      source: 'taps-export.sql',
      sourceSha256: sha256(SCRIPT),
    });
    const fees = await db.query(
      'SELECT fee_numerator, fee_denominator FROM legacy_delegator_fees ORDER BY fee_numerator',
    );
    // 5,25% e 10,00% — nenhum dos dois é representável como `number`.
    expect(fees.map((row) => row.fee_numerator)).toEqual([525n, 1_000n]);
    expect(fees.every((row) => row.fee_denominator === 10_000n)).toBe(true);
  });

  it('não carrega a carteira cifrada nem o hash de senha do settings', async () => {
    expect(SCRIPT).toContain('U2FsdGVkX1+encryptedphrase==');
    await importLegacyExport(db, SCRIPT, {
      source: 'taps-export.sql',
      sourceSha256: sha256(SCRIPT),
    });

    const tables = (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      (row) => String(row.name),
    );
    for (const table of tables) {
      const dump = JSON.stringify(await db.query(`SELECT * FROM ${table}`), replacer);
      expect(dump).not.toContain('U2FsdGVkX1+');
      expect(dump).not.toContain('/opt/lucee');
    }
  });
});

describe('a frase que a Migração diz quando não importa nada', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = new NodeSqliteDatabase(':memory:');
    await migrate(db);
  });
  afterEach(() => db.close());

  it('não afirma que faltam INSERT em um arquivo que os tem', () => {
    // O defeito nº 2 do relato: a frase mandava procurar no lugar errado.
    // Este arquivo tem um INSERT que o parser não lê.
    const strange = 'INSERT INTO payments SET total = 1;';
    expect(explainEmptyScript(strange, 'x.sql')).not.toMatch(/nenhum INSERT/u);
  });

  it('diz que o banco está vazio quando o arquivo só tem CREATE TABLE', async () => {
    const empty = 'CREATE CACHED TABLE "PUBLIC"."PAYMENTS"(\n  "CYCLE" INTEGER\n);\n';
    await expect(
      importLegacyExport(db, empty, { source: 'vazio.sql', sourceSha256: sha256(empty) }),
    ).rejects.toThrow(/1 CREATE TABLE e nenhum INSERT.*tapsDB/su);
  });

  it('diz que o arquivo não é um export quando ele não é', async () => {
    const wrong = 'oi, tudo bem?';
    await expect(
      importLegacyExport(db, wrong, { source: 'errado.txt', sourceSha256: sha256(wrong) }),
    ).rejects.toThrow(/não tem nenhum INSERT nem nenhum CREATE TABLE/u);
  });

  it('nomeia as tabelas que faltam quando o SCRIPT rodou no banco errado', async () => {
    const other = [
      'CREATE CACHED TABLE "PUBLIC"."SESSIONLOG"("ID" INTEGER, "WHEN" VARCHAR(30));',
      'INSERT INTO "PUBLIC"."SESSIONLOG" VALUES (1, \'2024-01-15\');',
    ].join('\n');
    // Antes, isto "importava com sucesso": zero pagamentos, um registro em
    // `legacy_import` e uma tela dizendo que o histórico chegou.
    await expect(
      importLegacyExport(db, other, { source: 'outro.sql', sourceSha256: sha256(other) }),
    ).rejects.toThrow(/nenhuma delas está numa tabela de histórico.*delegatorsPayments/su);
    expect((await db.query('SELECT COUNT(*) AS n FROM legacy_import'))[0]!.n).toBe(0n);
  });

  it('recusa um INSERT que não sabe ler em vez de pular a tabela dele', () => {
    // A varredura antiga não achava este comando e seguia em frente: as duas
    // linhas de `payments` sumiam sem uma palavra.
    const mixed = [
      'CREATE CACHED TABLE "PUBLIC"."PAYMENTS"("CYCLE" INTEGER, "TOTAL" DECIMAL(20, 6));',
      'INSERT INTO "PUBLIC"."PAYMENTS" SELECT * FROM "PUBLIC"."ANTIGO";',
      'INSERT INTO "PUBLIC"."PAYMENTS" VALUES (810, 1.000000);',
    ].join('\n');
    expect(() => parseH2Script(mixed)).toThrow(LegacyParseError);
    expect(() => parseH2Script(mixed)).toThrow(/não entendi o INSERT que começa em/u);
  });

  it('não confunde a palavra dentro de um nome com um comando', () => {
    const named = [
      'CREATE CACHED TABLE "PUBLIC"."BONDPOOL"("ADDRESS" VARCHAR(50), "NAME" VARCHAR(50));',
      "INSERT INTO \"PUBLIC\".\"BONDPOOL\" VALUES ('tz1a', 'INSERT INTO fulano');",
    ].join('\n');
    expect(findInsertStatements(named)).toHaveLength(1);
    expect(parseH2Script(named)[0]!.values.get('name')).toEqual({
      kind: 'text',
      value: 'INSERT INTO fulano',
    });
  });
});

/** `JSON.stringify` não sabe serializar `bigint`. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
