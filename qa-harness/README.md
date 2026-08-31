# Harness de QA — payout ponta a ponta em Bakingnet

Portão que decide se uma entrega de pagamento do TAPS pode ir para revisão.

Suíte unitária verde não é entrega validada. Este harness existe porque o TAPS tem
~4 200 linhas de teste, thresholds de cobertura configurados, e mesmo assim o cálculo de
recompensa devolvia zero para todos os delegadores com os testes passando. O que faltava
não era mais teste unitário: era um lugar onde o dinheiro se move de verdade e alguém
confere o resultado **contra a cadeia**.

Powered by TzKT API — <https://tzkt.io>.

---

## O que ele faz

1. Provisiona um baker de testes em **Bakingnet** e um coorte de delegadores montado para
   conter, de propósito, cada caso que derruba o TAPS atual.
2. Roda uma distribuição completa: planeja, estima na rede, injeta.
3. **Reconcilia mutez a mutez** o que foi pago on-chain contra o que o sistema disse que
   ia pagar — lendo da TzKT **e** da RPC, nunca do banco do próprio sistema.
4. Roda a mesma distribuição de novo e prova que a segunda **não envia**.
5. Mata o processo entre a injeção e a confirmação e prova que a retomada **recusa** em
   vez de pagar de novo.
6. Prova que os cenários **conseguem reprovar**, sabotando o motor um defeito por vez.

## Baker de testes provisionado

Já existe um em Bakingnet, provisionado em 2026-08-30:

| | |
|---|---|
| baker | `tz1eW8EU3oTGsyCBNccrXz62LdoY7BcFwhdU` |
| estado | `delegate`, ativo, **6000 XTZ** stakeados (`minimal_stake` lido da cadeia) |
| delegadores | 124 |
| explorador | <https://bakingnet.tzkt.io/tz1eW8EU3oTGsyCBNccrXz62LdoY7BcFwhdU> |

A chave dele fica em `state/cohort.json`, que **não** vai para o git. Quem não tiver esse
arquivo cria o próprio baker com o passo a passo abaixo — é para isso que ele existe.

## Comandos

```bash
npm ci

npm run doctor                       # rede, endpoints, estado do coorte
npm run setup                        # cria baker + coorte do zero (leva ~3 min)
npm run run                          # distribuição real + reconciliação + idempotência
npm run run -- --dry-run             # só planeja; não injeta nada
npm run selftest                     # prova que os cenários conseguem reprovar
npm run selftest -- --plan-only      # só os mutantes que não movem dinheiro
npm run selftest:offline             # idem, sem rede e sem baker provisionado
```

`--offline` não faz uma única chamada de rede: coorte gerado em memória, taxa e gas de
fixture gravada, nada injetado. Roda em segundos, sem chave e sem faucet — é o que o CI
de PR executa. Ele **não prova nada sobre movimentação de dinheiro**: idempotência,
conta não alocada e reconciliação exigem a cadeia.

Código de saída 0 quando tudo passa, 1 quando algo reprova. Com `--sabotage` ligado a
lógica se inverte: **passar** é a falha, porque o mutante deveria ter sido pego.

## Recriar o baker de testes do zero

Não é preciso guardar chave nenhuma. Todo o estado sai do faucet e é reproduzível.

```bash
cd qa-harness
npm ci

# 1. Baker + coorte. Gera as chaves, saca do faucet de Bakingnet (prova de trabalho,
#    ~334 desafios para 8000 XTZ, ~3 min) e aloca só as contas que devem estar alocadas.
npm run setup -- --stage accounts --fund 8000

# 2. Confere.
npm run doctor

# 3. Distribuição real.
npm run run
```

O estado fica em `state/`:

| arquivo | o que é |
|---|---|
| `cohort.json` | chaves do baker e dos delegadores (modo `0600`) |
| `journal/*.jsonl` | diário de injeção, append-only — **nunca apague** |
| `carry-over.json` | saldo de poeira acumulado entre ciclos |

`state/` e `reports/` estão no `.gitignore`. As chaves são de testnet e descartáveis:
para começar de novo, `rm -rf state/` e rode o setup outra vez.

### Renovar o coorte sem gastar o faucet de novo

```bash
npm run setup -- --stage cohort
```

Gera membros novos mantendo o baker. Útil porque os casos de borda **apodrecem**: depois
de receber uma vez, a conta "nunca alocada" passa a existir e o cenário dela vira uma
linha verde que não testa mais nada. O harness já renova esses endereços sozinho a cada
rodada (`refreshCohort`); este comando serve para trocar o coorte inteiro.

### Fazer o baker ter recompensa de verdade

As rodadas acima movem dinheiro real em Bakingnet, mas o **valor** a distribuir vem de um
split sintético — o baker de testes ainda não fechou ciclos. Para ter um
`rewards/split` real:

```bash
npm run setup -- --stage fund --fund 5000   # saca mais do faucet, se precisar
npm run setup -- --stage baker              # registra o delegado e stakeia o mínimo
npm run setup -- --stage delegate           # delega o coorte ao baker
npm run setup -- --stage staking-params     # abre o baker para stake externo
npm run setup -- --stage stake              # o membro `staker` delega e stakeia
```

Rode `staking-params` **cedo**. Um delegado nasce com
`limit_of_staking_over_baking_millionth = 0` e edge de 100 %: ninguém pode stakear nele,
e sem staker o coorte nunca exercita Adaptive Issuance — os campos `*StakedShared`, que o
protocolo já pagou e que pagar de novo é pagar em dobro, nunca aparecem num split real.
Os parâmetros levam `delegate_parameters_activation_delay` ciclos para valer (5, lido da
cadeia; ~30 h nesta rede), então adiar só empurra a espera. A etapa `stake` recusa com a
razão escrita enquanto eles não estiverem ativos.

Depois é espera de calendário, e não há como acelerar:

- direitos de consenso só valem depois de `consensus_rights_delay` ciclos (2, lido da cadeia);
- a recompensa do ciclo N é creditada no **último bloco do ciclo N**;
- distribuir só depois que N+2 começar, por causa da janela de denúncia;
- em Bakingnet um ciclo é 3600 blocos × 6 s = **6 h**.

Total: **~24 h** entre registrar o baker e ter um ciclo pagável — e **~36 h** até haver
stake externo, por causa do `delegate_parameters_activation_delay`. A partir daí:

```bash
npm run run -- --split tzkt:<endereço-do-baker>/<ciclo>
```

## A emenda: recompensa real, pagamento real

As duas metades separadas não bastam. Pool sintético pago de verdade prova a mecânica do
dinheiro; recompensa real conferida em papel prova a fórmula. O que fecha é rodar as duas
juntas — e isso não exige rodar um baker:

```bash
npm run run -- --split tzkt:tz1XMiZwHpHZ8a1AfwRWKfzLskJgZNyV8PHs/555
```

Split de um ciclo **fechado** de um baker que realmente está bakando (números reais,
delegadores reais, 3 stakers reais), plano calculado a partir dele, e o pagamento **feito
de verdade** na Bakingnet a partir do baker de testes, reconciliado contra a cadeia.

Rodado em 2026-08-31 — op
[`oocauEEx7hPuDq6YkJ9rY53vYPywewDD5jypDi5bwo7m4Zdajpn`](https://bakingnet.tzkt.io/oocauEEx7hPuDq6YkJ9rY53vYPywewDD5jypDi5bwo7m4Zdajpn):

```
pool real 28 468 033 mutez → 21 262 826 pagos em 6 transferências, todas applied
intenção == cadeia, conferido pela TzKT e pela RPC
2ª execução: 0 injeções
6 de 10 cenários exercitados, nenhum reprovou — 4 n/a (o split não é o do coorte)
```

Os quatro `n/a` são honestos: o split de outro baker não contém o endereço tz4 do coorte,
nem a conta não alocada, nem o valor de poeira, e tem 6 delegadores em vez de 126. Esses
casos são exercitados na rodada com coorte próprio; esta rodada prova a emenda.

## Auditoria de dado real (`audit`)

```bash
npm run audit -- --baker tz1XMiZwHpHZ8a1AfwRWKfzLskJgZNyV8PHs --cycle 555
```

Só leitura, e sem como deixar de ser: não recebe chave nenhuma. Confere leitura e
aritmética contra um **ciclo fechado de um baker que realmente está bakando**.

Existe por um motivo desconfortável: o baker de testes deste harness tem direitos de
consenso, mas **não há um daemon `octez-baker` atrás dele**. Ele perde todos os direitos e
fecha o ciclo com pool zero, e pool zero não valida fórmula nenhuma. Sem um baker de
verdade a aritmética nunca encosta em recompensa real.

Sete checagens, com três estados. `n/a` é para o que **este ciclo não exercitou** — um
baker sem staker não prova nem desmente nada sobre stakers. Marcar isso como verde seria
mentir por omissão; o rodapé mostra quantas foram exercitadas de fato.

Resultado em 2026-08-31, três bakers × três ciclos fechados da Bakingnet: **9 de 9 sem
reprovação**. Exemplo (`tz1XMiZwHpHZ…`, ciclo 555, pool 28 468 033 mutez, 6 delegadores,
3 stakers):

```
passa  lista-completa        Σ delegatedBalance 75572265326 == externalDelegatedBalance
passa  poder-de-baking       staked 1180513823243 + delegated/3 == bakingPower 1210868119280
passa  aritmetica-fecha      own 4842670 + taxa 2362536 + Σdevido 21262826 + sobra 1 = 28468033
n/a    staker-puro-nao-recebe
passa  stake-fora-do-pool    *StakedShared 104740109 mutez ficou de fora
passa  staker-delegador-recebe-so-o-delegado
passa  nada-excede-o-pool    sobra 1 mutez
```

O número que justifica tudo: **`*StakedShared` = 104 740 109 mutez, contra um pool
distribuível de 28 468 033.** O rendimento de stake é 3,7× o que o baker tem para pagar à
mão. Somá-lo ao pool — o que o TAPS atual faria — pagaria 4,7× o devido.

### Duas coisas que este comando pegou, ambas na conferência e não no motor

1. **Assumi que staker não pode estar no batch.** O dado real reprovou: os três stakers
   daquele baker **também são delegadores**. Um mesmo endereço tem saldo delegado e saldo
   stakeado com o mesmo baker; o delegado tem de ser pago. A checagem virou "staker *puro*
   não recebe" mais "quem é os dois recebe só pelo delegado".

2. **Ordem das operações da taxa.** A checagem calculava `bruto × (den − num) ÷ den` onde a
   §3.4 manda `taxa = bruto × num ÷ den` e `pagável = bruto − taxa`. Parece equivalente e
   não é, porque a divisão é inteira: com bruto 7 e taxa de 10 %, a ordem certa dá 7 e a
   "equivalente" dá 6. Reprovou um ciclo real (`tz1MbwKSdbL5…`/553) — o motor estava certo,
   a conferência é que estava errada.

## A trava de ciclo

`--split tzkt:<baker>/<ciclo>` recusa antes de ler qualquer número quando o ciclo não é
distribuível. Três casos, todos verificados contra a Bakingnet real:

| ciclo pedido | resposta |
|---|---|
| futuro | `ciclo 559 ainda não começou (ciclo corrente: 557)` |
| corrente | `ciclo 557 ainda não é distribuível … Distribua a partir do ciclo 559` |
| sem direitos | `TzKT não tem split para … (HTTP 204)` |

A trava existe porque a TzKT devolve um split **legítimo e vazio** para ciclo futuro:
`delegatorsCount = 0`, pool 0, nenhum campo inválido. Sem ela o harness reprovava — mas
acusando a causa errada ("endereço tz4 rejeitado pela validação"), quando o motivo real
era que o ciclo não tinha acontecido. Diagnóstico errado custa quase tanto quanto
diagnóstico nenhum.

A regra de N+2 é a janela de denúncia: `denunciation_period = 1` e `slashing_delay = 1`
significam que uma denúncia do ciclo N ainda pode reduzir o valor durante N+1.

## A trava de rede

`src/guard.ts` só aceita o `chain_id` de Bakingnet (`NetXvNVUNbWHxGt`), e essa constante
**não é lida de env, de arquivo nem de argumento**. Trocar a rede exige editar e commitar
o arquivo, o que aparece em revisão de código.

São duas barreiras independentes:

1. **URL**: hosts de mainnet conhecidos são recusados antes de qualquer I/O.
2. **`chain_id`**: o que a própria cadeia responde é comparado com o permitido. Uma URL
   chamada "bakingnet" apontando para mainnet reprova aqui.

Verificado:

```
$ TAPS_QA_RPC_URL=https://rpc.tzbeta.net npm run doctor
TRAVA DE REDE: endpoint RPC "https://rpc.tzbeta.net" é um host de mainnet conhecido.

$ TAPS_QA_RPC_URL=https://prod.tcinfra.net/rpc/mainnet npm run doctor
TRAVA DE REDE: RPC ... respondeu chain_id NetXdQprcVkpaWU (mainnet).

$ TAPS_QA_RPC_URL=https://rpc.shadownet.teztnets.com npm run doctor
TRAVA DE REDE: RPC ... respondeu chain_id NetXsqzbfFenSTS (shadownet).
```

Mainnet é decisão humana, toda vez. Nunca deste processo.

## Cenários

| nome | o que afirma |
|---|---|
| `aritmetica-fecha` | o plano bate valor a valor com a fórmula recalculada do zero |
| `lista-de-delegadores-completa` | ninguém some entre o split e o plano |
| `conta-nao-alocada` | um destino nunca alocado recebe e não derruba o lote dos outros |
| `delegador-tz4` | endereço BLS é aceito e pago |
| `acima-de-100-delegadores` | mais de 100 destinatários são pagos, dividindo o lote pelo gas do bloco |
| `valor-de-poeira` | poeira não é paga, acumula, e o acumulado é pago quando passa do piso |
| `staker-nao-recebe-por-fora` | quem stakeia fica fora do batch |
| `cadeia-bate-com-a-intencao` | mutez a mutez, cadeia == intenção |
| `idempotencia-execucao-dupla` | a segunda execução não injeta |
| `idempotencia-retomada-apos-morte` | com o diário em estado indeterminado, a retomada recusa |

## A prova de que os cenários reprovam

`npm run selftest` liga um defeito por vez e **exige** que o harness reprove. Um mutante
que sobrevive significa que o cenário responsável por ele é decorativo, e o selftest diz
isso com o nome do cenário.

| mutante | defeito reproduzido | pego por |
|---|---|---|
| `idempotency` | não consulta o diário antes de injetar | `idempotencia-execucao-dupla` |
| `storage-limit` | `storageLimit` fixo em 0 | `conta-nao-alocada` |
| `tz4-rejected` | validação de endereço por regex sem `tz4` | `delegador-tz4` |
| `batch-cap` | `MAX_BATCH_SIZE=100` sem dividir | `acima-de-100-delegadores` |
| `float-mutez` | conversão de valor passando por float | `aritmetica-fecha` |
| `pagination-truncated` | lê só a primeira página de delegadores | `lista-de-delegadores-completa` |
| `pay-staked-shared` | soma `*StakedShared` ao pool | `aritmetica-fecha` |
| `stakers-as-delegators` | trata stakers como delegadores | `staker-nao-recebe-por-fora` |
| `no-floor` | sem piso de pagamento | `valor-de-poeira` |

O selftest já se pagou: a primeira versão de `checkPlanArithmetic` conferia
`own + taxa + Σdevido + sobra == pool` usando a sobra que o **próprio motor** calculou
como `distribuível − Σdevido`. Isso fecha com qualquer valor de "devido", inclusive
errado — o mesmo defeito do `validateCalculation()` do TAPS. O mutante `float-mutez`
passava incólume, e foi o selftest que apontou. A versão atual recalcula tudo a partir
do split, não do motor.

## O portão no CI

`.github/workflows/qa-gate.yml`. Nenhum passo usa `continue-on-error`.

| job | quando roda | o que impõe |
|---|---|---|
| `harness-selftest` | todo push e PR | tipos + `selftest --offline`: os cenários conseguem reprovar, sem rede nem chave |
| `detect-app` | todo push e PR | existe `src-tauri/Cargo.toml`? |
| `build` (linux, windows, android) | só quando `detect-app` diz que sim | os três alvos da ADR-0001 buildam |
| `payout-bakingnet` | `workflow_dispatch` | rodada real: setup, distribuição, reconciliação, selftest completo |

O app do TAPS chega no estágio 5 (BRES-48/BRES-49). Até lá o job de build fica
**pulado** — cinza, não verde: ninguém lê "buildou" onde não buildou. E não fica
vermelho: um `main` vermelho por semanas ensina a squad a ignorar o CI, que foi
exatamente como os 12 erros TS2300 sobreviveram no `main` sem ninguém notar.
Decisão de Rafael em 2026-08-30.

Ninguém precisa lembrar de ligar o job depois: ele passa a valer sozinho no commit que
criar `src-tauri/Cargo.toml`.

> A detecção é um job com checkout, não um `if: hashFiles(...)` no job de build.
> `hashFiles()` num `if` de job roda **antes** do checkout, sobre um workspace vazio, e
> devolveria "não existe" para sempre — inclusive depois do app existir. O portão nunca
> mais armaria, e nada avisaria.

## Ligar o motor do TAPS aqui

O harness não conhece a implementação. Ele fala com a interface `PayoutEngine`
(`src/payout/types.ts`): `plan(split, policy)` puro, `execute(plan)` idempotente.
`ReferenceEngine` é o oráculo do teste, **não** o motor de produção — quando BRES-46
entregar, basta implementar a mesma interface e passá-la ao runner.

## Configuração

Endpoints vêm de env, nunca de constante de negócio no código:

| variável | default |
|---|---|
| `TAPS_QA_RPC_URL` | `https://rpc.bakingnet.teztnets.com` |
| `TAPS_QA_TZKT_URL` | `https://api.bakingnet.tzkt.io` |
| `TAPS_QA_FAUCET_URL` | `https://faucet.bakingnet.teztnets.com` |
| `TAPS_QA_STATE_DIR` | `./state` |
| `TAPS_QA_TZKT_CONCURRENCY` | `2` (1–4) |

Constante de protocolo **nunca** vem de env nem do código: é lida da cadeia a cada
execução. `blocks_per_cycle` é 14 400 em mainnet e **3600 em Bakingnet** — um valor
escrito na fonte erra por 4× no próprio testnet, e erra em silêncio.
