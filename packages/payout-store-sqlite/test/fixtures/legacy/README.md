# Bancos de verdade do TAPS antigo

Os quatro `.sql` deste diretório não foram escritos à mão. São a saída do
comando `SCRIPT` de um H2 **de verdade**, rodando sobre um banco criado pelo
**DDL do próprio TAPS em ColdFusion** — o mesmo `components/environment.cfc` e
`components/database.cfc` que estão no histórico deste repositório, no commit
`6b598e78`, o último antes de o CFML ser removido.

A razão de existirem é um critério de aceite do BRES-48: *"Migração testada com
um banco da versão anterior"*. A primeira versão do teste usava um arquivo que
**eu** tinha escrito a partir de `migration-docs/DATABASE_SCHEMA.md` — ou seja,
a minha leitura do formato, conferida contra ela mesma. Trocar isso por bancos
gerados pelo H2 achou três coisas que a leitura não acharia.

## As quatro combinações, e por que são quatro

|  | H2 1.3.172 | H2 1.4.200 |
|---|---|---|
| **`old`** — instalação que nunca atualizou | `h2-1.3.172-old.sql` | `h2-1.4.200-old.sql` |
| **`upgraded`** — instalação que rodou uma versão nova | `h2-1.3.172-upgraded.sql` | `h2-1.4.200-upgraded.sql` |

**As duas versões de H2 importam.** 1.3.172 é a do `.lex` que o guia de
instalação do TAPS antigo manda baixar das extensões do Lucee. Quem instalou
depois pode ter pego uma 1.4.x.

**As duas formas de instalação importam** porque o CFML altera o schema em
execução, e cada `ALTER` está dentro de um `<cftry>` que engole a falha:

- `checkSixDecimals()` (`database.cfc:769`) troca `total` de `DECIMAL(20,2)`
  para `DECIMAL(20,6)`.
- `addTxHashFields()` (`database.cfc:793`) acrescenta `TRANSACTION_HASH`.

Uma instalação que nunca rodou essas funções tem **duas casas decimais e
nenhuma coluna de hash**. Não é hipótese: é o que o `CREATE TABLE` do
`environment.cfc` produz.

## O que isto achou

1. **`INSERT` sem lista de colunas.** O H2 1.4.200 escreve
   `INSERT INTO "PUBLIC"."PAYMENTS" VALUES (…)`, e a ordem vem do `CREATE TABLE`
   acima. O parser só entendia a forma da 1.3.172 e recusava o arquivo inteiro
   com *"não encontrei nenhum INSERT"* — dizendo ao baker que o arquivo estava
   errado quando o errado era o leitor.

2. **O `migration-docs/DATABASE_SCHEMA.md` não descreve o schema inicial.** Ele
   documenta `DECIMAL(20,6)` e `TRANSACTION_HASH` como se sempre tivessem
   existido, e documenta em `settings` mais de dez colunas que só aparecem
   depois do `addV120Fields()`. Quem escrever código a partir daquele documento
   escreve para uma instalação atualizada e quebra na outra.

3. **A chave primária de `payments` não existe.** `ALTER TABLE payments ADD
   PRIMARY KEY (baker_id, cycle, date, result)` é recusado pelo H2, porque
   `date` é anulável — e o `<cftry>` engole. Dá para ver a ausência no export.

## O que o baker perdeu antes de a migração existir

Na instalação `old`, o delegador que recebeu `0.003970 ꜩ` aparece com
`0.00`. **O H2 arredondou na escrita**, em 2019, dentro de uma coluna de duas
casas. O importador traz `0` porque é o que está lá; não há como recuperar o
valor, e inventá-lo seria pior. É a razão pela qual o total importado difere
entre `old` (120,000000 ꜩ) e `upgraded` (120,003970 ꜩ) sobre os *mesmos*
pagamentos.

## O quinto arquivo: `bres-125-taps-export.sql`

Este não veio do `run.sh`. É o anexo do BRES-125, byte por byte — o export que
um baker gerou seguindo o `MIGRACAO-DA-VERSAO-ANTIGA.md` num H2 1.4.200 e que a
Migração recusou dizendo *"não encontrei nenhum INSERT"*. Ele está aqui inteiro
porque tem o que os outros quatro não têm: as 28 colunas de `settings` de uma
instalação v1.2.0, a tabela `bondPoolSettings`, e espaço em branco no fim de
quase toda linha.

Não edite: `test/unit/legacy-script-to.spec.ts` afirma essas três formas antes
de usar o arquivo, justamente para que ninguém o "arrume" e deixe o teste
passando contra um arquivo mais fácil que o do baker.

## Gerar de novo

```bash
curl -LO https://repo1.maven.org/maven2/com/h2database/h2/1.3.172/h2-1.3.172.jar
./run.sh ./h2-1.3.172.jar h2-1.3.172-upgraded upgraded
./run.sh ./h2-1.3.172.jar h2-1.3.172-old      old
```

`run.sh` usa `-continueOnError` de propósito: é o que espelha o `<cftry>` de
cada `CREATE`/`ALTER` do CFML. Sem isso o banco gerado seria mais correto que o
do baker, e o teste passaria contra uma ficção.
