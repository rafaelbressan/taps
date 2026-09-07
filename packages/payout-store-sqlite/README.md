# `@tezos-suite/payout-store-sqlite`

O `PayoutStore` do TAPS em SQLite. É onde o estado que impede pagar duas vezes
passa a ser durável, e é o que substitui o Postgres do desenho de nuvem.

Ele existe por causa de uma frase da análise: `prisma/migrations/` continha um
único `.gitkeep`, e `prisma migrate deploy` terminava com sucesso sem criar uma
tabela. O sistema subia e falhava na primeira consulta.

## O que ele garante, e onde isso está escrito

As propriedades que mantêm o dinheiro seguro são **colunas e restrições**, não
`if`s:

| Propriedade | Onde vive |
|---|---|
| Uma distribuição por `(baker, ciclo)` | `PRIMARY KEY (baker_id, cycle)` |
| Uma operação pertence a um lugar só, para sempre | `operation_hashes.op_hash PRIMARY KEY`, compartilhado entre ciclos e quitações de dívida |
| A liquidação inteira ou nada | uma transação por escrita que toca mais de uma linha |
| Nada apaga histórico financeiro | `ON DELETE RESTRICT` em toda chave estrangeira |
| Valor monetário é exato | `INTEGER` com `CHECK (x >= 0)`, lido como `bigint` |
| A tentativa anterior nunca é apagada | `batch_attempts` é append-only |

O schema antigo tinha o espelho de cada uma: sem `@@unique([bakerId, cycle])`,
com `onDelete: Cascade` de `Settings` apagando todo o histórico financeiro, e
com `clearPreviousAttempt()` apagando a evidência da tentativa anterior antes de
reenviar.

## Um contrato, duas implementações

`test/unit/contract.spec.ts` roda a **mesma suíte** contra o
`InMemoryPayoutStore` de referência e contra este. A afirmação que o motor
inteiro sustenta — "é a restrição que impede o pagamento duplo, não o fluxo de
controle" — só é conferível se a restrição valer em toda implementação do port.

`test/unit/durability.spec.ts` prova a outra metade: o motor morre entre injetar
e confirmar, um **processo novo** abre o mesmo arquivo, e a retomada não injeta
nada — ela pergunta à cadeia pelo hash que já estava gravado.

## Dois pontos de entrada

```ts
import { SqlitePayoutStore, migrate } from '@tezos-suite/payout-store-sqlite';       // portátil
import { openPayoutDatabase, inspectBackup } from '@tezos-suite/payout-store-sqlite/node';
```

O de cima não importa nenhum módulo do Node e roda dentro da webview do
aplicativo desktop, contra a conexão que o Rust abriu. O de baixo é o que
precisa de sistema de arquivos e de `node:sqlite`.

Essa separação não é arrumação: um `import 'node:sqlite'` que chegue ao bundle
da webview faz a janela abrir em branco, antes de qualquer tela existir.

## Migrations

Estão em `src/migrations.ts`, **no código**, não em arquivos ao lado do
binário — um schema que depende de arquivos instalados corretamente é um schema
que vai faltar na máquina que importa.

Três regras, e o runner as aplica em vez de confiar:

- **Append-only.** Uma migration publicada nunca é editada. Se o nome gravado
  não bater com o do binário, o runner para: as duas máquinas não têm mais o
  mesmo schema, mesmo dizendo a mesma versão.
- **Banco mais novo que o código para tudo.** Acontece quando alguém abre uma
  versão antiga do app sobre um backup restaurado.
- **Uma transação por migration**, junto com a linha de bookkeeping. Uma queda
  no meio deixa a versão anterior, nunca metade da nova.

## Importar o banco da versão antiga

`importLegacyExport` lê o que o comando `SCRIPT TO 'taps-export.sql'` do H2
produz. O formato de arquivo do H2 não tem leitor fora da JVM, e exigir Java na
máquina do baker seria pior que ler texto.

Os valores são convertidos por `tezToMutez` a partir dos **caracteres exatos**
do arquivo. A versão antiga usava `Math.floor(tez * 1e6)`, que perde um mutez em
1,15% dos valores, sempre para baixo. Porcentagem vira racional exato: 5,25%
é 525/10000, nunca 0,0525.

O teste não usa um arquivo que eu escrevi: usa **quatro bancos que o H2 gerou**
a partir do DDL do próprio TAPS em ColdFusion, em duas versões de H2 (1.3.172,
a do `.lex` do Lucee, e 1.4.200) e nas duas formas de instalação que existem
(atualizada e nunca atualizada). A receita e o que eles acharam estão em
`test/fixtures/legacy/README.md` — inclusive um `INSERT` sem lista de colunas
que fazia o importador recusar o arquivo inteiro.

Nada de `settings` atravessa além do endereço do baker. As colunas de
credencial — `pass_hash`, `hash_salt`, `phrase`, `app_phrase` — são lidas,
contadas e descartadas: são uma carteira cifrada com sal literal e sem
autenticação, e importá-las seria carregar um modelo de custódia quebrado para
um produto que decidiu não guardar chave nenhuma.

## Rodar

```bash
npm ci
npm run verify   # sem number no caminho do dinheiro + tipos + 94 testes
```

`node:sqlite` exige Node 22.
