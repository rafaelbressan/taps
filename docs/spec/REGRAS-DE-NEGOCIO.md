# TAPS — Especificação das regras de negócio

Este documento extrai, de `migration-docs/BUSINESS_LOGIC.md` (981 linhas descrevendo o TAPS
original em ColdFusion), do esquema H2 documentado em `migration-docs/DATABASE_SCHEMA.md`, dos
endpoints em `migration-docs/API_ENDPOINTS.md` e do código TypeScript atual, **as regras de domínio
do produto** — o que o TAPS decide sobre dinheiro, independentemente de linguagem, framework ou
banco.

É o ativo que sobrevive à reescrita. O código não.

## Como ler

Três categorias, deliberadamente separadas porque hoje estão misturadas:

| Prefixo | Categoria | Quem manda |
|---|---|---|
| **RN** | Regra de negócio | O produto. É decisão nossa e do baker. |
| **RR** | Regra da rede | A Tezos. Referência para o levantamento de protocolo (BRES-38); **não duplicada aqui**. |
| **AI** | Acidente da implementação antiga | Ninguém. É jeito de fazer em CFML/H2 e **não deve ser carregado adiante**. |
| **DP** | Decisão pendente | Rafael. Não há resposta no código nem na documentação. |

Cada RN tem **enunciado** (uma frase), **exemplo numérico** e **caso de borda** — o caso que
quebra a regra ou expõe seu limite. Onde há dinheiro, o exemplo fecha em **mutez inteiros**
(1 XTZ = 1 000 000 mutez).

**Convenção de unidade usada nesta especificação:** todo valor monetário é inteiro em mutez.
Comissões são inteiros em pontos-base (bp): 5,00% = 500 bp, 100% = 10 000 bp. A aritmética em
XTZ com ponto flutuante que aparece no sistema atual é um acidente (AI-01, AI-02), não uma regra.

**Sinal de status:** onde a regra descreve o que o sistema faz **hoje** e isso está errado, o texto
diz explicitamente "hoje" e aponta a correção. Regra correta e comportamento atual não são a mesma
coisa, e este documento não finge que são.

---

## Glossário

- **Baker** — quem opera o nó que assina blocos. Dono da instalação do TAPS. Um `baker_id` por instalação.
- **Delegador** — quem delega saldo ao baker sem transferir a posse, e tem direito a parte da recompensa.
- **Ciclo** — unidade de tempo da rede em que as recompensas são apuradas. Duração e atraso de
  liberação são RR, não RN.
- **Bond pool** — grupo de pessoas que aportou capital para o baker operar; recebe a parcela da
  recompensa que **não** foi para os delegadores.
- **Gestor do bond pool** (`is_manager`) — um único membro por baker, que além da própria cota
  recebe todas as taxas administrativas do pool.
- **Comissão** (`fee`) — percentual da recompensa bruta do delegador retido pelo baker.
- **Taxa administrativa** (`adm_charge`) — percentual retido da cota de um membro do bond pool e
  repassado ao gestor. É outra coisa, com outro dono.
- **Lote** (batch) — uma única operação Tezos contendo várias transferências.

---

# Parte 1 — Regras de negócio (RN)

## 1.1 Comissão

### RN-01 — Comissão padrão do baker

**Enunciado.** Toda recompensa bruta de delegador é reduzida pela comissão padrão do baker
(`settings.default_fee`, 0 a 100%), salvo se houver comissão individual para aquele endereço
(RN-02).

**Exemplo.** Comissão padrão 500 bp (5,00%), ciclo com três delegadores:

| Delegador | Bruto (mutez) | Retido pelo baker | Pago |
|---|---:|---:|---:|
| A | 10 000 000 | 500 000 | 9 500 000 |
| B | 3 333 333 | 166 667 | 3 166 666 |
| C | 1 | 1 | 0 |

Total pago aos delegadores: 12 666 666 mutez. Retido pelo baker: 666 668 mutez.
Soma: 13 333 334 = bruto total. ✔

**Borda.** O delegador C tem direito a 0,95 mutez. Mutez é a menor unidade da rede; não existe
fração. O valor trunca para 0 e ele não é pago (RN-08), mas continua com registro de auditoria
com total 0. A diferença de 1 mutez fica com o baker (RN-05).

---

### RN-02 — Comissão individual por delegador

**Enunciado.** Um delegador pode ter comissão própria registrada em `delegatorsFee (baker_id,
address, fee)`; existindo essa linha, ela substitui a comissão padrão para aquele endereço, sem
exceção e sem combinação.

**Exemplo.** Comissão padrão 500 bp; delegador VIP com linha `fee = 0`:

- bruto 5 432 100 mutez, comissão 0 bp → paga **5 432 100 mutez** (o baker retém 0).
- mesmo bruto com a padrão de 500 bp pagaria 5 160 495 mutez.
- diferença para o baker: 271 605 mutez no ciclo.

**Borda.** Comissão individual de 10 000 bp (100%): o delegador recebe 0 e não entra no lote
(RN-08), mas o sistema não distingue "delegador com 100% de comissão" de "delegador sem
recompensa". O baker que quiser suspender alguém tem, hoje, exatamente a mesma tela que quem
quer cobrar 100% — e nenhum aviso. Ver **DP-11**.

---

### RN-03 — Cálculo do pagamento do delegador

**Enunciado.** O valor pago a um delegador é a recompensa bruta apurada pela rede para aquele
delegador naquele ciclo, menos a comissão aplicável, truncado para mutez inteiro.

```
pago_mutez = floor( bruto_mutez × (10000 − fee_bp) / 10000 )
```

**Exemplo.** bruto 5 432 100 mutez, comissão 500 bp:

```
5 432 100 × 9 500 = 51 604 950 000
51 604 950 000 / 10 000 = 5 160 495 (exato)
pago = 5 160 495 mutez        retido = 271 605 mutez
5 160 495 + 271 605 = 5 432 100 ✔
```

**Borda.** bruto 1 000 003 mutez, comissão 500 bp:

```
1 000 003 × 9 500 = 9 500 028 500
9 500 028 500 / 10 000 = 950 002,85  → floor → 950 002
pago = 950 002        retido = 50 001
950 002 + 50 001 = 1 000 003 ✔ (a fração de 0,85 mutez ficou com o baker)
```

A conta **precisa** fechar em inteiros. A implementação atual converte para XTZ, arredonda em 6
casas com `Decimal.js` e volta para mutez com `Math.floor(tez * 1e6)` — e `Math.floor(0,29 × 1e6)`
dá 289 999, não 290 000. Erro sistemático, sempre contra o delegador. Ver **AI-02**.

---

### RN-04 — A comissão é a única retenção sobre o delegador

**Enunciado.** O delegador recebe exatamente o valor calculado em RN-03; nenhuma taxa de rede,
custo de alocação ou rateio de operação é descontado dele.

**Exemplo.** Três delegadores no ciclo, taxa de rede de 1 800 mutez por transferência:

```
pagos:   5 160 495 + 950 002 + 3 920 000 = 10 030 497 mutez (entra na conta dos delegadores)
taxas:   3 × 1 800                       =      5 400 mutez (sai da carteira do baker)
débito total na carteira do baker        = 10 035 897 mutez
```

**Borda.** Delegador com direito a 12 mutez: o baker gasta 1 800 mutez de taxa para entregar
12 mutez — 150× o valor pago. A regra continua válida (o delegador recebe 12), mas ela só é
sustentável com um valor mínimo de pagamento, que **não existe**. Ver **DP-01**.

> A taxa de rede sai da carteira do baker. Essa é a resposta à pergunta "quem paga a taxa".
> Ela é uma decisão de produto e pode ser mudada — ver **DP-02**.

---

### RN-05 — O resíduo de truncamento fica com o baker

**Enunciado.** Toda fração de mutez perdida no truncamento de RN-03 e do rateio do bond pool
(RN-13) permanece na carteira do baker; nenhum resíduo é redistribuído.

**Exemplo.** Bond pool com 10 000 000 mutez a ratear entre três membros de cota idêntica:

```
10 000 000 / 3 = 3 333 333,33...  → cada membro recebe 3 333 333
3 × 3 333 333 = 9 999 999
resíduo = 1 mutez, permanece com o baker
```

**Borda.** Com 250 delegadores, o resíduo acumulado por ciclo chega a 249 mutez — irrelevante em
valor, mas suficiente para reprovar qualquer teste que exija `soma(pagamentos) == bruto`. O
invariante correto é `soma(pagamentos) + retido + resíduo == bruto`, com resíduo ≥ 0 e
resíduo < número de destinatários.

---

## 1.2 Ciclo e gatilho

### RN-06 — A distribuição é disparada pela virada de ciclo

**Enunciado.** A cada `update_freq` minutos o sistema compara o ciclo pendente da rede com o ciclo
pendente registrado localmente; quando o da rede avança à frente do local, o ciclo local vira
pagável e a distribuição é executada para ele.

**Exemplo.** Local pendente = 800; a consulta à rede retorna pendente = 801.

```
1. payments(cycle=800) passa de 'rewards_pending' para pagável
2. cria payments(cycle=801, result='rewards_pending', total=0)
3. executa a distribuição do ciclo 800
```

**Borda.** Sistema desligado durante três ciclos: a rede está em 804 e o local em 800. A regra
processa **apenas o 800** e grava 804 como novo pendente — os ciclos 801, 802 e 803 ficam sem
pagamento e sem registro de que foram pulados. O comportamento correto seria processar a fila
inteira, um ciclo por vez, em ordem. Ver **DP-07**.

---

### RN-07 — Um ciclo pendente por vez, por baker

**Enunciado.** Existe no máximo um ciclo em `rewards_pending` por baker em qualquer instante; a
existência de dois é estado inválido e deve falhar alto.

**Exemplo.** Estado válido depois da virada descrita em RN-06:

```
cycle 799 → paid              total 118 450 000   opHash op1...
cycle 800 → paid              total  12 666 666   opHash op2...
cycle 801 → rewards_pending   total           0   opHash null
```

**Borda.** A chave natural do banco atual é `(baker_id, cycle, date, result)`, que **permite** duas
linhas `rewards_pending` para ciclos diferentes e, pior, duas linhas para o mesmo ciclo com datas
diferentes. O invariante existe na documentação e não existe no esquema. Ver **AI-03**.

---

## 1.3 Modos de operação

### RN-08 — Três modos: `off`, `simulation`, `on`

**Enunciado.** O modo de operação determina, e só ele determina, se a distribuição roda e se ela
toca a cadeia.

| Modo | Job periódico | Grava no banco | Injeta operação | Registro gerado |
|---|---|---|---|---|
| `off` | não roda | não | não | nenhum |
| `simulation` | roda | sim, com status `simulated` | **não** | completo |
| `on` | roda | sim, com status `applied`/`failed` | **sim** | completo |

**Enunciado complementar:** `simulation` produz **exatamente os mesmos números** que `on`
produziria no mesmo instante. Um resultado de simulação que não bate com o pagamento real é bug,
não diferença de modo.

**Exemplo.** Ciclo 800, três delegadores, modo `simulation`:

```
delegatorsPayments: A 9 500 000 simulated
                    B 3 166 666 simulated
                    C         0 simulated
payments:           cycle 800   simulated   total 12 666 666   transaction_hash NULL
operações injetadas: 0
```

Mudando para `on` e reprocessando o mesmo ciclo, os três valores são idênticos e aparece um
`transaction_hash`.

**Borda.** O modo é lido no início do processamento e não é reconferido antes de injetar. Um baker
que muda de `on` para `off` durante uma distribuição já iniciada tem o lote enviado assim mesmo.
Além disso, hoje o disparo **manual** (`POST /payments/distribute/:cycle`) não consulta o modo: em
`off`, o job periódico realmente não roda, mas o disparo manual executa e se comporta como
`simulation`. Isso é ambíguo por acidente. Ver **DP-08**.

---

### RN-09 — Nenhum valor zero entra no lote

**Enunciado.** Delegador cujo valor calculado é 0 mutez não gera transferência, mas gera registro
de auditoria com total 0.

**Exemplo.** Delegador C de RN-01: bruto 1 mutez, comissão 500 bp, calculado 0.

```
lote:               nenhuma transferência para C
delegatorsPayments: C, cycle 800, total 0, result 'simulated'|'applied'
log:                "Ignored tz1C... (value is 0)"
```

**Borda.** Um delegador cujo saldo caiu a quase nada aparece em todo ciclo com valor 0, poluindo o
relatório sem nunca receber. E a regra "zero não paga" é hoje o **único** filtro de poeira que
existe: 1 mutez paga, 0 mutez não. Ver **DP-01**.

---

## 1.4 Execução do pagamento

### RN-10 — Um ciclo é pago em lote

**Enunciado.** Todos os pagamentos de delegadores de um ciclo são enviados como uma única operação
Tezos em lote; todos os destinatários daquele lote compartilham o mesmo hash de operação.

**Exemplo.** Ciclo 800, três destinatários, uma operação `op2...`:

```
delegatorsPayments cycle=800:
  A  9 500 000  applied  op2...
  B  3 166 666  applied  op2...
  C          0  applied  op2...     (sem transferência, ver RN-09)
payments cycle=800: total 12 666 666, transaction_hash op2...
```

**Borda.** Lote é atômico: **se uma transferência falha, nenhuma acontece**. Um único destinatário
problemático — conta não alocada, endereço inválido, limite de storage insuficiente — trava a
distribuição do ciclo inteiro e ninguém recebe. Acima de certo número de destinatários o lote
também não cabe em uma operação e precisa ser dividido, o que quebra a atomicidade e cria o
problema de "quais lotes já foram enviados". Limite e custo são **RR** (ver Parte 2); a política
de divisão é **DP-05**.

---

### RN-11 — Retentativa: N tentativas espaçadas de M minutos

**Enunciado.** Se a distribuição não confirmar, o sistema aguarda `min_between_retries` minutos e
tenta de novo, até `payment_retries` tentativas, e ao esgotar marca o ciclo como `errors`.

**Exemplo.** `payment_retries = 3`, `min_between_retries = 5`, ciclo de 118 450 000 mutez:

```
t=0min    tentativa 1 → RPC devolve erro antes de injetar → não confirmado
t=5min    tentativa 2 → injetada op7..., confirmada
resultado: payments(800) = paid, total 118 450 000, hash op7..., 2 tentativas
```

**Borda — este é o caso que faz o sistema pagar duas vezes.** Se a tentativa 1 **injetar** a
operação e só então perder a confirmação (timeout, queda do RPC, resposta perdida), o dinheiro já
saiu. A tentativa 2 injeta o mesmo lote outra vez e a carteira do baker é debitada em
236 900 000 mutez para uma dívida de 118 450 000. Hoje o `catch` engole o erro, `clearPreviousAttempt()`
**apaga o registro da primeira tentativa**, e nenhum ponto do fluxo consulta o hash anterior antes
de reenviar.

A regra só é segura sob RN-12. Retentativa sem idempotência não é retentativa: é pagamento duplo
com espera no meio.

---

### RN-12 — A distribuição de um ciclo é idempotente

**Enunciado.** Executar a distribuição de um ciclo já pago não injeta nenhuma operação nova e não
altera nenhum valor; a intenção de pagamento é persistida com o hash da operação **antes** de a
tentativa ser considerada encerrada, e nenhum reenvio ocorre sem antes verificar o estado on-chain
do hash anterior.

**Exemplo.** Ciclo 800 pago em `op2...` com 12 666 666 mutez. Segunda execução:

```
1. lê a intenção persistida do ciclo 800 → opHash = op2...
2. consulta o estado on-chain de op2... → aplicada
3. não injeta nada; retorna o mesmo resultado
carteira do baker: debitada uma vez, 12 666 666 mutez + taxas
```

**Borda — o caso que precisa reprovar.** Tentativa 1 injeta `op9...` e o processo morre antes de
gravar o resultado. Na retomada, a intenção persistida já traz `op9...`; a consulta on-chain diz
"aplicada"; o sistema fecha o ciclo como pago e **não** reenvia. Se a consulta disser "não
encontrada" após o horizonte de finalidade da rede (RR), aí sim reenvia. Se a consulta falhar, o
ciclo fica **bloqueado para intervenção humana** — nunca "tenta de novo por via das dúvidas".

Existe um teste que demonstra isso ou a regra não está implementada. Este é o critério.

---

### RN-13 — Ordem: delegadores primeiro, bond pool depois, e só se aquilo deu certo

**Enunciado.** O bond pool só é distribuído após a confirmação bem-sucedida do pagamento dos
delegadores do mesmo ciclo; delegador confirmado é pré-condição, não paralelo.

**Exemplo.** Ciclo 800: lote de delegadores `op2...` confirmado → calcula e envia o lote do bond
pool `op3...`. Duas operações distintas, dois hashes, mesma data.

**Borda.** Delegadores confirmados e bond pool falhando deixa o ciclo em estado misto — pago para
uns, não pago para outros — que o modelo atual (um `result` por ciclo) **não consegue representar**.
Ver **DP-06**.

---

## 1.5 Bond pool

### RN-14 — O bond pool recebe o que sobra do ciclo

**Enunciado.** A base de rateio do bond pool é a recompensa total do ciclo menos o total
efetivamente pago aos delegadores.

```
base_pool = recompensa_total_do_ciclo − total_pago_aos_delegadores
```

**Exemplo.** Recompensa total 100 000 000 mutez; pago aos delegadores 80 000 000:

```
base_pool = 20 000 000 mutez
```

**Borda.** Como o total pago aos delegadores é **líquido**, a comissão que o baker cobrou dos
delegadores está dentro da base do pool — ou seja, a comissão do baker é rateada entre os membros
do bond pool. Isso pode ser exatamente a intenção (o pool financia a operação e participa da
receita) ou pode ser um efeito colateral nunca decidido. Ver **DP-03**.

Borda adicional: se a base der ≤ 0 (recompensa lida menor que o pago, o que acontece hoje sempre
que a leitura de recompensa volta zerada), o bond pool **não distribui nada**. Nunca calcula
valores negativos.

---

### RN-15 — Rateio proporcional à cota

**Enunciado.** Cada membro do bond pool recebe a fração da base proporcional à sua cota sobre a
soma das cotas.

**Exemplo.** Base 20 000 000 mutez; cotas: gestor 5 000, membro A 3 000, membro B 2 000 (total 10 000):

| Membro | Cota | % | Antes da taxa adm. |
|---|---:|---:|---:|
| Gestor | 5 000 | 50% | 10 000 000 |
| A | 3 000 | 30% | 6 000 000 |
| B | 2 000 | 20% | 4 000 000 |

**Borda.** Cota total igual a zero (pool habilitado, nenhum membro, ou todos com cota 0): a divisão
é impossível e o pool não distribui. Cota negativa é estado inválido e deve falhar alto — nunca
ser normalizada para zero.

---

### RN-16 — Taxa administrativa: retida de cada membro, paga ao gestor

**Enunciado.** De cada membro é retido `adm_charge` por cento da sua cota do ciclo; a soma de todas
as retenções é paga ao gestor do pool, em transferência separada da cota dele.

**Exemplo.** Continuando RN-15, com `adm_charge = 200 bp (2%)` para todos:

| Membro | Antes | Taxa adm. | Líquido |
|---|---:|---:|---:|
| Gestor | 10 000 000 | 200 000 | 9 800 000 |
| A | 6 000 000 | 120 000 | 5 880 000 |
| B | 4 000 000 | 80 000 | 3 920 000 |

```
total de taxas adm. = 200 000 + 120 000 + 80 000 = 400 000 mutez

lote do bond pool:
  gestor  9 800 000   (cota líquida)
  A       5 880 000
  B       3 920 000
  gestor    400 000   (taxas administrativas)
  total  20 000 000 mutez = base ✔
```

O gestor recebe 10 200 000 mutez em **duas** transferências, não uma.

**Borda.** O gestor paga taxa administrativa sobre a própria cota e a recebe de volta na segunda
transferência — resultado líquido idêntico a não cobrar dele, mas com duas transferências e duas
taxas de rede. E se `adm_charge` do gestor for diferente da dos demais, a assimetria é invisível
no relatório. Ver **DP-04**.

---

### RN-17 — Um gestor por baker

**Enunciado.** Existe no máximo um membro com `is_manager = true` por baker; marcar um novo gestor
desmarca o anterior na mesma operação.

**Exemplo.** Pool com gestor `tz1M`. Ao marcar `tz1N` como gestor:

```
tz1M.is_manager := false
tz1N.is_manager := true
(uma transação; nunca um estado intermediário com dois ou zero gestores)
```

**Borda.** Pool habilitado, membros com `adm_charge > 0` e **nenhum** gestor: existem 400 000 mutez
de taxas administrativas sem destinatário. A distribuição precisa falhar alto — nunca pagar as
taxas a quem calhar, nunca engolir o valor.

Borda documental: o pseudocódigo de `distributeRewards()` em `BUSINESS_LOGIC.md` §2.2 ordena os
membros por `is_manager DESC` e faz `break` ao encontrar o gestor. Lido literalmente, isso encerra
o laço na **primeira** iteração sempre que existe gestor, e só o gestor seria pago. Ou o
pseudocódigo está errado, ou o TAPS original pagava só o gestor. **Não inventamos a resposta** —
ver **DP-09**.

---

## 1.6 Elegibilidade dos delegadores

### RN-18 — Direito à recompensa vem do snapshot do ciclo, não do saldo atual

**Enunciado.** O que define quem recebe e quanto é a fotografia do saldo delegado no nível de
snapshot daquele ciclo, apurada pela rede; o saldo do delegador no momento do pagamento é
irrelevante.

**Exemplo.** Delegador com 10 000 000 000 mutez (10 000 XTZ) delegados no snapshot do ciclo 800.
Ele saca tudo no dia seguinte. Quando o ciclo 800 vira pagável, ele **recebe normalmente** a
recompensa do 800, calculada sobre os 10 000 000 000 mutez do snapshot, mesmo com saldo delegado
zero na data do pagamento.

**Borda.** O simétrico: quem delegou **depois** do snapshot do ciclo 800 não aparece na apuração do
800 e recebe zero, ainda que esteja delegando há semanas quando o pagamento sai. Do ponto de vista
do delegador isso parece erro; é a regra da rede. O produto precisa **explicar** isso na interface,
não escondê-lo. Qual é o nível exato do snapshot e como a rede o determina é **RR**.

---

### RN-19 — Destinatário inválido não pode derrubar o ciclo

**Enunciado.** Um endereço que a instalação não consegue pagar — formato inválido, tipo não
suportado, conta não alocada com custo de alocação proibitivo — é tratado individualmente, com
registro explícito do motivo, sem impedir o pagamento dos demais.

**Exemplo.** Ciclo com 40 delegadores, um deles em conta ainda não alocada:

```
39 delegadores pagos no lote principal          op2...
 1 delegador retido, motivo 'conta_nao_alocada', total 4 320 000, result 'held'
payments(800): parcialmente pago, 39/40, valor retido 4 320 000
```

**Borda — comportamento atual, que é o oposto disto.** Hoje: (a) a validação de endereço roda no
orquestrador e, ao encontrar **um** endereço inválido, lança antes de distribuir — ninguém do ciclo
recebe; (b) endereços `tz4` são rejeitados pelo validador, então um delegador `tz4` sozinho impede
o pagamento de todos; (c) o lote é montado com `storageLimit: 0`, e uma conta não alocada consome
storage — a operação inteira é rejeitada pela rede e ninguém recebe.

Três caminhos distintos, mesmo resultado: **um delegador trava o ciclo**. O enunciado acima é a
regra que queremos; a política concreta (pular / reter / pagar em separado) é **DP-04**.

---

### RN-20 — Todo delegador conhecido tem comissão registrada

**Enunciado.** Ao detectar um delegador novo, o sistema cria para ele a linha de comissão com o
valor padrão vigente, de modo que a comissão de qualquer delegador seja sempre consultável e
auditável, e não inferida.

**Exemplo.** Comissão padrão 500 bp. Delegador `tz1X` aparece pela primeira vez no ciclo 801:

```
delegatorsFee += (baker, tz1X, 500)
```

Alterar a comissão padrão para 400 bp depois **não** muda `tz1X`: ele fica em 500 bp até ser
alterado individualmente.

**Borda.** É exatamente por isso que RN-01 ("padrão se aplica a quem não tem linha") e RN-20
("todo mundo ganha linha") convivem mal: na prática, depois do primeiro ciclo quase ninguém usa o
padrão, e mudar `default_fee` não tem o efeito que o baker espera. Ver **DP-11**.

Borda 2: delegador que sai continua com linha em `delegatorsFee`. Se voltar meses depois, volta com
a comissão antiga — não com a padrão atual. Isso é comportamento, não decisão: ninguém decidiu.

---

## 1.7 Operações fora do ciclo

### RN-21 — Lote manual por CSV

**Enunciado.** O baker pode enviar um lote arbitrário a partir de um CSV `endereço,valor_em_mutez`,
com pré-visualização obrigatória antes do envio.

**Exemplo.**

```csv
address,amount
tz1delegator1...,5000000
tz1delegator2...,3000000
```

Pré-visualização: 2 destinatários, 8 000 000 mutez + 2 × 1 800 mutez de taxa = 8 003 600 mutez
debitados da carteira do baker.

**Borda.** O lote manual **não** é gravado em `delegatorsPayments` — vai só para arquivo de log.
Consequência: não aparece em nenhum relatório, não entra na conciliação do ciclo, e um pagamento
manual feito por engano em cima de um ciclo já pago é invisível para o sistema. Todo movimento de
fundos deveria ter registro na mesma trilha. Ver **DP-10**.

---

### RN-22 — Trilha de auditoria por delegador e por ciclo

**Enunciado.** Todo pagamento fica registrado com ciclo, endereço, valor, data, resultado e hash da
operação, e esse registro é a fonte de verdade para relatório, conciliação e resposta a delegador.

**Exemplo.** Consulta de um delegador que reclama do ciclo 800:

```
cycle 800  tz1B...  3 166 666 mutez  applied  op2...  2026-08-27
```

Com esse registro se responde: quanto, quando, com que comissão e em que operação da cadeia — e o
delegador confere no explorador.

**Borda.** A trilha só é confiável se o status for gravado **depois** do fato. Hoje
`saveDelegatorPayments()` grava `applied` **antes** de enviar: um travamento entre gravar e enviar
deixa registros permanentemente mentindo que o pagamento foi aplicado. Status de dinheiro se grava
depois de acontecer, nunca antes.

---

### RN-23 — Validação de configuração

**Enunciado.** Comissão entre 0 e 10 000 bp, frequência de atualização de no mínimo 1 minuto,
endereço de baker em formato válido, e senha confirmada — nenhuma instalação começa a operar com
esses campos fora de faixa.

**Exemplo.** `default_fee = 11 000 bp` é rejeitado no setup: comissão acima de 100% pagaria valor
negativo ao delegador.

**Borda.** A validação de formato de endereço do setup original aceita `tz1`, `tz2` e `tz3` por
prefixo. Quais prefixos existem hoje e quais são pagáveis é **RR** — o produto não deve manter
essa lista escrita no código (ver AI-10).

---

# Parte 2 — Regras da rede (RR)

**Estas regras não são nossas e não estão detalhadas aqui.** Elas vêm do levantamento de protocolo
(BRES-38) e devem ser **lidas da cadeia em tempo de execução, com cache** — nunca escritas no
código. Este documento apenas registra **onde** o domínio depende delas, para que nenhuma volte a
virar constante literal.

| Ref. | O que a rede define | Onde o domínio depende |
|---|---|---|
| RR-01 | Duração do ciclo e nível de snapshot | RN-06 (gatilho), RN-18 (elegibilidade) |
| RR-02 | Atraso até a recompensa do ciclo ficar disponível | RN-06 (qual ciclo é pagável) |
| RR-03 | Finalidade de operação | RN-11, RN-12 (quando "não confirmada" vira "não existe") |
| RR-04 | Limites de gas e storage por operação | RN-10 (quantas transferências cabem no lote) |
| RR-05 | Custo de alocação de conta nova | RN-19 (destinatário não alocado), DP-01 |
| RR-06 | Precificação de taxa de rede | RN-04 (custo por transferência), DP-01 |
| RR-07 | Formatos de endereço válidos e pagáveis | RN-19, RN-23 |
| RR-08 | Saldo *staked* vs *delegated* e o *edge* do baker | RN-03 (existem **duas** parcelas com rendimentos diferentes), DP-12 |
| RR-09 | Paginação da API de indexação (recompensas, delegadores) | RN-01, RN-18 (quem entra na apuração) |

Duas consequências que já são certas e valem registrar como restrição de domínio:

1. **A apuração tem duas parcelas, não uma.** Com staking direto, a parcela delegada e a parcela
   stakeada rendem de forma diferente e precisam ser calculadas separadamente. Nenhuma regra deste
   documento assume uma parcela só; RN-03 se aplica a cada parcela conforme **DP-12**.
2. **Truncamento silencioso de lista é erro de dinheiro.** Se a apuração de delegadores vier
   paginada e a leitura não iterar, o ciclo paga um subconjunto e reporta sucesso. Lista incompleta
   precisa falhar alto, com o número esperado e o obtido na mensagem.

---

# Parte 3 — Acidentes da implementação antiga (AI)

**Nada aqui é regra.** São formas de fazer herdadas de CFML, do H2 ou da primeira tentativa em
TypeScript. Carregar qualquer uma adiante é repetir o erro.

### AI-01 — `((x) * 100) / 100` na fórmula de pagamento
A fórmula documentada é `((rewards / 1e6) * ((100 − fee) / 100) * 100) / 100`. O `* 100 / 100` final
é ruído de precisão de CFML. Não faz nada. A regra é RN-03.

### AI-02 — XTZ em ponto flutuante como unidade de cálculo
`DECIMAL(20,6)` no H2, `number` em JavaScript, `Math.floor(tez * 1e6)` na borda. Mutez inteiro é a
unidade canônica; XTZ é formatação de exibição. `bigint` do começo ao fim, sem exceção no caminho
do dinheiro.

### AI-03 — Data e status dentro da chave natural
`@@unique([bakerId, cycle, date, result])` e `(baker_id, cycle, address, date, result)` são chaves
que **permitem** duplicar o ciclo, bastando outra data ou outro status. A chave de negócio é
`(baker, ciclo)` para o pagamento do ciclo e `(baker, ciclo, endereço)` para o pagamento do
delegador. O banco tem que ser capaz de recusar o pagamento duplo — hoje ele o autoriza.

### AI-04 — Status como texto livre
`'not available'` com espaço, `'rewards_pending'`, `'errors'` — strings comparadas com `LOWER()` em
SQL. O conjunto de estados é fechado e pertence ao domínio; a divergência atual entre
`'not available'` e `not_available` já quebra escrita em produção.

### AI-05 — Arquivos de log como trilha de auditoria
`logs/payments_{cycle}.log`, `logs/batch_result_{cycle}.log`, `logs/last_error_{cycle}.log`,
`logs/bondPool_transactions_{cycle}.log`, `logs/customBatch_{timestamp}.log`. Log é diagnóstico. A
trilha auditável é RN-22, no banco. Nenhuma decisão de negócio pode depender de ler arquivo.

### AI-06 — Configuração de implantação dentro de `settings`
`application_port`, `client_path`, `node_alias`, `base_dir`, `funds_origin`, `proxy_server`,
`proxy_port`. Nada disso é domínio. Nada disso pertence à mesma tabela que a comissão do baker.

### AI-07 — `curl` → `wget` → `cfhttp` em cascata
Estratégia de fallback de requisição HTTP da era CFML. Não é regra de resiliência; é contorno de
ambiente.

### AI-08 — `sleep(10 minutos)` depois de enviar o lote do bond pool
Espera fixa no lugar de confirmação. Substituída por RN-12 e RR-03.

### AI-09 — `num_blocks_wait = 8`, `gas_limit = 15400`, `storage_limit = 300`, `transaction_fee = 0.0018`
Constantes de protocolo da era pré-2020, gravadas na tabela de configuração e editáveis pelo
usuário. São RR-03, RR-04 e RR-06 — lidas da cadeia e estimadas por operação, nunca configuradas
à mão.

### AI-10 — Lista de prefixos de endereço no código
`tz1|tz2|tz3|KT1` como expressões regulares literais. É RR-07. A lista atual já está desatualizada:
`tz4` é rejeitado, e um delegador com esse endereço não recebe.

### AI-11 — `BLOCKS_PER_CYCLE = 4096` e `CYCLES_UNTIL_DELIVERED = 5`
Idem: RR-01 e RR-02. Com o valor errado, o sistema calcula o ciclo errado — paga antes de a
recompensa existir, ou atrasa sem motivo. Existe um `getConstants()` que leria isso da cadeia e o
resto do código o ignora; ele próprio lê campos que deixaram de existir.

### AI-12 — `MAX_BATCH_SIZE = 100` como número mágico
O limite real de um lote vem de RR-04 (gas e tamanho de operação), não de um inteiro escolhido.
Cem transferências provavelmente já não cabem.

### AI-13 — Dupla criptografia da frase-senha em duas colunas `VARCHAR(150)`
O **requisito** é real e é regra: o sistema paga sem operador presente, logo precisa assinar sem
alguém digitar senha (RN-08, modo `on`). O mecanismo — frase cifrada duas vezes, uma com a senha do
usuário e outra com uma semente da aplicação, em colunas de texto — é acidente, e um de segurança.
Como custodiar a chave de assinatura é assunto do núcleo criptográfico (BRES-37/BRES-41).

### AI-14 — Reprocessar cria linha nova em vez de atualizar
Como a data faz parte da chave (AI-03), reprocessar um ciclo no dia seguinte gera outra linha em
vez de conflitar. É consequência do modelo, não intenção.

---

# Parte 4 — Decisões pendentes (DP)

**Nenhuma destas tem resposta no código ou na documentação.** Estão listadas com o que se sabe e
com opções, sem resposta inventada. São de Rafael.

### DP-01 — Qual é o valor mínimo de pagamento?
**Hoje não existe.** O único filtro é "zero não paga" (RN-09). Um delegador com direito a 12 mutez
entra no lote e custa 1 800 mutez de taxa; se a conta dele ainda não for alocada, custa também o
valor de alocação (RR-05), que é ordens de grandeza maior.
**Opções:** (a) mínimo fixo em mutez, configurável; (b) mínimo relativo — só paga se o valor
cobrir K× a taxa da transferência; (c) acumular o saldo devido entre ciclos e pagar quando cruzar
o mínimo (exige registrar dívida acumulada por delegador — regra nova, tabela nova).
**Recomendação:** (c) com piso configurável e padrão conservador; (a) é mais simples e perde o
delegador pequeno para sempre.

### DP-02 — A taxa de rede continua saindo do baker?
Hoje sai (RN-04). A alternativa é descontar do valor do delegador. Muda a economia do produto e
muda o que o delegador vê. **Confirmar que fica como está** ou decidir a mudança — não é decisão
técnica.

### DP-03 — A comissão cobrada dos delegadores deve entrar na base do bond pool?
Hoje entra, por construção (RN-14): a base é `total − pago aos delegadores`, e o pago é líquido.
Isso significa que o baker rateia a própria comissão com os membros do pool. Pode ser a intenção.
Nunca foi decidido explicitamente.

### DP-04 — Delegador que não pode ser pago: pula, retém, ou trava o ciclo?
Cenários distintos com respostas possivelmente distintas: endereço em formato desconhecido; tipo de
endereço não suportado pela carteira; conta não alocada (paga-se o custo de alocação?); contrato
(`KT1`) que pode rejeitar a transferência.
**Opções:** (a) pular e registrar; (b) reter o valor e pagar no ciclo seguinte; (c) pagar em
operação separada, aceitando o custo; (d) falhar o ciclo — que é o comportamento atual e o pior de
todos.
**Recomendação:** (a) para formato inválido, (c) para conta não alocada acima do mínimo de DP-01.
Depende de DP-01.

### DP-05 — Como dividir um ciclo que não cabe em um lote?
Acima do limite da rede (RR-04) a distribuição precisa de vários lotes, e a atomicidade de RN-10 se
perde. Precisa de: critério de divisão, registro de qual lote foi enviado, e o que significa "ciclo
pago" quando 7 de 10 lotes confirmaram. Amarrado a DP-06 e a RN-12.

### DP-06 — O que o baker vê quando um ciclo é pago pela metade?
Hoje não há resposta: `payments.result` é um único valor por ciclo (`paid` ou `errors`), então
"metade paga" não é representável. Um lote de vários que falha, ou um bond pool que falha depois de
delegadores confirmados (RN-13), produzem exatamente esse estado.
**Precisa decidir:** existe estado `partially_paid`? O que ele mostra — quantos pagos, quanto pago,
quanto falta, quais hashes? Ele bloqueia o ciclo seguinte até resolução humana? A resposta define
modelo de dados e interface.

### DP-07 — Ciclos pulados enquanto o sistema esteve fora do ar
RN-06 processa um ciclo por virada e descarta os intermediários. **Pagar retroativo por padrão?
Nunca? Perguntar ao baker?** Um sistema parado por uma semana pode ter três ciclos devidos.

### DP-08 — `off` significa "não paga automaticamente" ou "não paga de jeito nenhum"?
Hoje o job periódico respeita `off`, mas o disparo manual não consulta o modo e se comporta como
simulação. Ambíguo por acidente. Provavelmente `off` deveria bloquear também o disparo manual — mas
isso remove a única forma de o baker forçar um pagamento com o automático desligado.

### DP-09 — O bond pool original pagava todos os membros ou só o gestor?
O pseudocódigo de `BUSINESS_LOGIC.md` §2.2 ordena por `is_manager DESC` e faz `break` no gestor, o
que encerraria o laço na primeira iteração. Ou o pseudocódigo está errado, ou o comportamento real
era esse. **Verificável** contra o histórico do CFML ou contra pagamentos reais de um baker que
usou bond pool. Enquanto não for verificado, RN-15/RN-16 descrevem a intenção documentada, não o
comportamento observado.

### DP-10 — O lote manual (CSV) entra na trilha de auditoria?
Hoje só vai para arquivo (RN-21). Se entrar no banco, precisa de um tipo de movimento distinto de
"pagamento de ciclo", senão contamina a conciliação por ciclo.

### DP-11 — Comissão padrão: aplica retroativamente aos delegadores existentes?
RN-20 grava a padrão vigente para cada delegador novo, então mudar `default_fee` não muda ninguém
já cadastrado — provavelmente não é o que o baker espera ao editar "comissão padrão".
**Opções:** (a) a padrão é um valor vivo e só existe linha individual para exceções explícitas
(recomendado, e é o que RN-01 diz); (b) mantém como está e a interface deixa claro que a mudança
vale só para novos.
Relacionado: comissão de 100% como forma de suspender um delegador precisa ser um estado
próprio, não um valor de comissão.

### DP-12 — Comissão sobre a parcela *stakeada*
Com staking direto, o delegador tem duas parcelas com rendimentos distintos e o baker tem um *edge*
definido pelo protocolo sobre a parcela stakeada (RR-08). **A comissão do TAPS incide sobre as
duas? Só sobre a delegada? Existe uma comissão separada para cada?** Sem essa decisão não é
possível calcular a recompensa corretamente no protocolo atual — é a pendência de maior impacto
desta lista.

### DP-13 — Uma instalação, um baker?
Todo o modelo tem `baker_id` como chave, sugerindo multi-baker, mas a autenticação e várias
consultas assumem instalação única (há consulta de ciclo pendente que não filtra por baker). Se
multi-baker for suportado, isolamento entre bakers vira requisito de segurança, não detalhe.

### DP-14 — O que fazer quando o saldo da carteira não cobre o ciclo?
**Hoje não há verificação alguma:** o lote é montado, a rede rejeita, o laço de retentativa repete,
o ciclo é marcado `errors` e ninguém recebe — sem que em nenhum momento a mensagem diga "faltou
saldo".
**A regra precisa ser decidida:** (a) verificar saldo ≥ total + taxas antes de montar e, faltando,
não enviar nada e avisar; (b) pagar até onde o saldo alcança, por algum critério de ordem
(proporcional? maiores primeiro? menores primeiro?) e deixar o resto devido; (c) pagar
proporcionalmente a todos, reduzindo cada valor.
**Recomendação:** (a). Pagamento parcial por falta de saldo cria dívida por delegador (DP-01c) e
estado parcial (DP-06) de uma vez só, e nenhum dos dois existe hoje.

---

## Critério de pronto

Uma implementação atende esta especificação quando:

1. Todo valor no caminho do dinheiro é inteiro em mutez, do cálculo à assinatura (RN-03, AI-02).
2. Existe teste que **reprova** o pagamento duplicado descrito em RN-11 e passa com RN-12.
3. Nenhuma constante de RR está escrita no código (Parte 2, AI-09/AI-11/AI-12).
4. Nenhum campo de API externa é lido com valor padrão silencioso: campo esperado que não veio é
   erro alto com o nome do campo na mensagem (Parte 2, consequência 2).
5. Toda validação escrita tem um caso que a faz reprovar.
6. Cada DP está respondida ou explicitamente registrada como aberta na interface do baker — nunca
   respondida por omissão no código.
