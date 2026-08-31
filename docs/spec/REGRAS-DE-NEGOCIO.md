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

**Estado das decisões.** As 14 decisões pendentes da versão anterior foram respondidas por Rafael
em 2026-08-30 e viraram regra. A Parte 4 deixou de ser lista de perguntas e passou a ser o registro
do que foi decidido, com o ponteiro para a RN que carrega cada decisão. Só **DP-09** continua
aberta, e não é decisão: é fato a recuperar.

**Numeração.** O número de uma RN é identidade, não ordem de leitura. As regras criadas pelas
decisões de 2026-08-30 (RN-24 a RN-29) estão posicionadas na seção temática a que pertencem, com
número fora de sequência.

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
quer cobrar 100% — e nenhum aviso. Resolvido em **RN-20**: suspender é estado próprio, não
comissão de 100%.

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

**Duas parcelas, uma comissão (decidido em DP-12).** O delegador pode ter saldo *delegado* e saldo
*stakeado*, que rendem de forma diferente. **A comissão do TAPS incide apenas sobre a recompensa da
parcela delegada.** A parcela stakeada é remunerada pelo *edge* do baker, definido e cobrado pelo
próprio protocolo (RR-08) — o TAPS não cobra por cima dele.

```
delegador com recompensa delegada 5 432 100 e stakeada 2 000 000, comissão 500 bp:

parcela delegada:  floor(5 432 100 × 9 500 / 10 000) = 5 160 495   (baker retém 271 605)
parcela stakeada:                                      2 000 000   (comissão 0 — o edge já é do baker)
pago ao delegador:                                     7 160 495 mutez
```

**Borda da regra.** Se a apuração devolver as duas parcelas somadas num único campo, não existe
cálculo correto possível: aplicar a comissão sobre o total cobra duas vezes a parcela stakeada, e
não aplicar entrega de graça a delegada. Nesse caso a distribuição **falha alto** — nunca escolhe
um dos dois erros. Como as parcelas são expostas é RR-08.

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
sustentável com um valor mínimo de pagamento — que passa a existir em **RN-24**.

> **Decidido (DP-02): a taxa de rede sai da carteira do baker e continua assim.** O delegador
> recebe o valor líquido cheio. É o que ele assume ao comparar comissões entre bakers, e descontar
> a taxa dele faria o valor recebido depender do preço de gas do dia.

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
inteira, um ciclo por vez, em ordem — que é o que **RN-28** determina.

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

### RN-28 — Ciclo devido não se perde: existe fila

**Enunciado.** Todo ciclo com recompensa devida e não paga entra numa fila processada em ordem
crescente, um ciclo por vez; acima de um limite configurável de ciclos devidos o sistema **para** e
pede confirmação humana antes de pagar qualquer um. *(decidido em DP-07)*

**Exemplo.** Limite de segurança 3 ciclos. Sistema volta depois de uma parada e encontra os ciclos
800, 801 e 802 devidos:

```
3 ciclos ≤ limite → processa em ordem
  ciclo 800 → distribuição própria, lote próprio, hash próprio
  ciclo 801 → só começa depois do 800 fechar
  ciclo 802 → só começa depois do 801 fechar
```

Com 800, 801, 802 e 803 devidos (4 > 3), não paga nada: registra os quatro como devidos, informa o
total acumulado e espera decisão do baker.

**Borda.** Cada ciclo da fila é uma distribuição independente e idempotente (RN-12). Falha no 801
**não** avança para o 802 — a fila para no ciclo que falhou e o estado vira RN-27. Pular um ciclo
para "não travar a fila" é como se paga duas vezes ou se deixa de pagar sem ninguém notar.

O limite existe pelo cenário concreto: voltar de uma viagem e ver a carteira esvaziar de uma vez,
sem nenhum aviso, porque o sistema decidiu sozinho pagar uma semana de ciclos.

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

**`off` desliga tudo (decidido em DP-08).** Nenhum caminho de entrada — job periódico, API, CLI,
disparo manual — distribui com o modo em `off`. Para pagar, o baker muda o modo explicitamente.
Um sistema de dinheiro em que "desligado" ainda paga é a pior surpresa possível, e religar é um
comando.

**Borda.** O modo é lido no início do processamento e não é reconferido antes de injetar. Um baker
que muda de `on` para `off` durante uma distribuição já iniciada tem o lote enviado assim mesmo —
o modo precisa ser reconferido imediatamente antes da injeção, e não só na entrada.

Comportamento atual, que viola a regra: o disparo manual (`POST /payments/distribute/:cycle`) não
consulta o modo, então em `off` o job periódico não roda mas o disparo manual executa e se comporta
como `simulation`.

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
existe: 1 mutez paga, 0 mutez não. O filtro de verdade é **RN-24**, que trata valor pequeno como
dívida a acumular em vez de pagamento a fazer.

---

### RN-24 — Valor abaixo do mínimo vira dívida, não vira pó

**Enunciado.** Um pagamento só entra no lote se o valor devido cobrir K vezes o custo estimado da
transferência; abaixo desse corte o valor **não é descartado** — fica registrado como dívida do
baker com aquele delegador e soma ao ciclo seguinte, até cruzar o corte. *(decidido em DP-01:
corte relativo, com acúmulo)*

O corte é relativo, não fixo, porque o custo da transferência muda com a precificação da rede
(RR-06). K é configurável pelo baker.

**Exemplo.** K = 3 e custo estimado de 1 800 mutez por transferência → corte de 5 400 mutez.

| Ciclo | Devido no ciclo | Dívida acumulada | Paga? |
|---|---:|---:|---|
| 800 | 2 100 | 2 100 | não (2 100 < 5 400) |
| 801 | 2 400 | 4 500 | não (4 500 < 5 400) |
| 802 | 1 900 | 6 400 | **sim — paga 6 400, dívida zera** |

Nenhum mutez foi perdido: 2 100 + 2 400 + 1 900 = 6 400 = valor pago. O invariante que precisa
valer sempre é `soma paga + dívida em aberto == soma devida`.

**Borda.** Delegador que para de delegar com dívida em aberto abaixo do corte: a dívida nunca mais
cresce e nunca cruza o corte sozinha. Precisa de um caminho explícito de liquidação — pagamento
avulso a pedido, aceitando que a taxa custe mais que o valor. A dívida é do baker; ela não expira
por inatividade do delegador.

Borda 2: o corte não é motivo para esconder o delegador do relatório. Ele aparece em todo ciclo com
o devido do ciclo e a dívida acumulada, senão a regra vira "some com quem é pequeno".

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
de divisão é **RN-26**.

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
O estado que representa isso é **RN-27**.

---

### RN-25 — Sem saldo, não sai nada

**Enunciado.** Antes de montar o lote, o sistema verifica que o saldo disponível da carteira cobre
o total a pagar mais as taxas estimadas mais os custos de alocação de contas novas; faltando
qualquer parte, **não envia nada**, marca o ciclo como bloqueado por saldo e avisa com o valor que
falta. *(decidido em DP-14)*

**Exemplo.** Ciclo com 42 destinatários, um deles em conta ainda não alocada. Supondo custo de
transferência de 1 800 mutez e custo de alocação de 64 250 mutez, ambos lidos da cadeia (RR-05,
RR-06):

```
a pagar                     118 450 000
taxas    42 × 1 800       =      75 600
alocação 1 × 64 250       =      64 250
necessário                  118 589 850
saldo disponível            118 500 000
falta                            89 850  → não envia nada, avisa
```

**Borda.** Saldo suficiente na verificação e insuficiente na injeção, porque outra operação saiu da
mesma carteira no intervalo. A rede rejeita, e o caso cai em RN-11 e RN-12 — nunca em pagamento
pela metade silencioso. A verificação reduz a chance; ela não substitui a idempotência.

Borda 2: "saldo disponível" não é o saldo total. Parte do saldo do baker pode estar congelada como
depósito de segurança da própria atividade de baking; gastar isso é outro problema. Quanto do saldo
é gastável é RR.

---

### RN-26 — Ciclo que não cabe em um lote é dividido de forma determinística

**Enunciado.** Quando os pagamentos de um ciclo não cabem em uma única operação, eles são divididos
em lotes por uma ordem estável e determinística, e **cada lote é persistido com seu índice e seu
hash antes do envio**; a retomada continua do primeiro lote sem confirmação. *(decidido em DP-05)*

O número de transferências por lote sai do limite de gas e de tamanho de operação lidos da cadeia
(RR-04), nunca de uma constante escolhida.

**Exemplo.** 250 destinatários, limite da cadeia comportando 90 transferências por operação:

```
lote 1/3  90 destinatários  op_a...  confirmado
lote 2/3  90 destinatários  op_b...  confirmado
lote 3/3  70 destinatários  op_c...  sem confirmação

retomada: consulta op_a e op_b on-chain → aplicados, não reenvia
          trata apenas o lote 3 conforme RN-12
```

**Borda.** A ordem precisa ser determinística — ordenação por endereço, por exemplo. Se a ordem
variar entre execuções, a retomada monta lotes com composição diferente, o hash gravado não
corresponde ao que seria reenviado, e a verificação de RN-12 perde o sentido. Ordem instável aqui é
pagamento duplicado disfarçado.

---

### RN-27 — Ciclo pago pela metade tem estado próprio

**Enunciado.** Um ciclo cujo pagamento começou e não completou fica em estado `parcialmente_pago`,
que registra quais destinatários foram pagos, quanto saiu, quanto falta e o hash de cada lote; e
enquanto existir ciclo parcial, **o ciclo seguinte não é distribuído**. *(decidido em DP-06)*

**Exemplo.** Ciclo 800 com 250 destinatários, dois de três lotes confirmados (RN-26):

```
estado         parcialmente_pago
pagos          180 de 250 destinatários
saiu            94 000 000 mutez   lotes op_a..., op_b...
falta           31 500 000 mutez   lote 3, sem hash confirmado
ciclo 801      não distribui até o 800 sair do estado parcial
```

**Borda.** O mesmo estado cobre o caso de RN-13: delegadores confirmados e bond pool falhando
depois. É um ciclo parcialmente pago, com a parte faltante identificada como sendo do pool.

Borda 2: sair do estado parcial acontece por retomada bem-sucedida (RN-26) ou por decisão humana
explícita registrada. **Nunca por expiração de tempo** — um ciclo não deixa de estar pela metade
porque envelheceu.

---

## 1.5 Bond pool

### RN-14 — O bond pool recebe o que sobra do ciclo, sem a comissão do baker

**Enunciado.** A base de rateio do bond pool é a recompensa total do ciclo menos a recompensa
**bruta** dos delegadores; a comissão que o baker cobrou dos delegadores fica com o baker e não
entra na base. *(decidido em DP-03)*

```
base_pool = recompensa_total_do_ciclo − recompensa_BRUTA_dos_delegadores
```

**Exemplo.** Recompensa total do ciclo 100 000 000 mutez; bruto dos delegadores 80 000 000;
comissão 500 bp:

```
pago aos delegadores   floor(80 000 000 × 9 500 / 10 000) =  76 000 000
comissão do baker                                         =   4 000 000
base do bond pool      100 000 000 − 80 000 000           =  20 000 000

conferência: 76 000 000 + 4 000 000 + 20 000 000 = 100 000 000 ✔
```

Pela regra anterior — base = total − **líquido** — a base teria sido 24 000 000, e os 4 000 000 de
comissão seriam rateados entre os membros do pool.

**Por quê.** O pool aporta capital e deve render sobre capital. A comissão é a receita do baker por
operar o serviço: apurar, pagar, atender delegador, manter o nó de pé. São duas remunerações com
naturezas diferentes e não devem se misturar. Se em algum momento o bond pool passar a ser
sociedade na operação, e não capital com retorno, esta regra muda — e é uma mudança de contrato com
os membros do pool, não um ajuste de fórmula.

**Borda.** Se a base der ≤ 0 (recompensa lida menor que o pago, o que acontece hoje sempre
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
no relatório — o extrato do pool precisa mostrar taxa retida e taxa recebida em linhas separadas,
senão ninguém consegue conferir.

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

Três caminhos distintos, mesmo resultado: **um delegador trava o ciclo**.

**Política decidida (DP-04).** Duas regras, nesta ordem:

1. **Regra geral — pular e registrar.** Destinatário que não pode ser pago sai do lote com o motivo
   registrado, e o valor devido a ele vira dívida em aberto (RN-24). O ciclo segue para todos os
   outros. Nenhum endereço tem poder de impedir o pagamento de terceiros.
2. **Exceção — conta não alocada cujo valor cobre o custo de alocação.** Aí vale pagar: sai em
   operação separada do lote principal, com o custo de alocação absorvido pelo baker (RN-04), e o
   delegador passa a receber normalmente nos ciclos seguintes.

```
custo de alocação lido da cadeia: 64 250 mutez

delegador novo devendo 4 320 000 → 4 320 000 > 64 250 → paga em operação separada
delegador novo devendo    30 000 →    30 000 < 64 250 → pula, vira dívida (RN-24)
```

**Borda da política.** "Pular e registrar" só é aceitável porque o valor vira dívida. Pular
descartando o valor seria confiscar recompensa de delegador por um problema técnico do lado do
baker.

---

### RN-20 — A comissão padrão é um valor vivo

**Enunciado.** A comissão padrão se aplica a todo delegador que não tenha exceção explícita
registrada, inclusive aos já conhecidos; só existe linha individual em `delegatorsFee` quando
alguém decidiu uma exceção para aquele endereço. *(decidido em DP-11)*

**Exemplo.** Baker com 40 delegadores, comissão padrão 500 bp, um VIP com exceção de 0 bp:

```
delegatorsFee tem 1 linha, não 41:   (baker, tz1VIP, 0)

mudando a padrão para 400 bp:
  39 delegadores passam a 400 bp     (efeito imediato, é o que "padrão" quer dizer)
  tz1VIP continua em 0 bp            (exceção explícita, não é tocada)
```

Pela regra anterior — gravar a padrão vigente para cada delegador novo — a tabela teria 41 linhas e
mudar a padrão não mudaria ninguém, que é o oposto do que o campo promete.

**Borda.** Suspender um delegador **não** é comissão de 100%. É estado próprio do delegador, com
motivo registrado. Comissão e suspensão respondem perguntas diferentes: "quanto ele paga" e "ele
está ativo". Um valor de comissão de 10 000 bp deve ser possível e deve significar apenas isso —
comissão de 100% — nunca ser o mecanismo de desligar alguém.

Borda 2: delegador que sai e volta meses depois entra na comissão padrão vigente, não na antiga —
porque não há linha individual para ele. É o comportamento esperado, e agora é por construção.

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

**O lote manual entra na trilha de auditoria (decidido em DP-10).** Ele é gravado com tipo de
movimento próprio — `manual`, distinto de `pagamento_de_ciclo` — para aparecer no relatório e no
extrato do delegador sem contaminar a conciliação por ciclo.

```
movimento  manual   2026-08-30  tz1delegator1...  5 000 000  op_x...
movimento  manual   2026-08-30  tz1delegator2...  3 000 000  op_x...

conciliação do ciclo 800: não inclui estes dois (tipo diferente)
extrato de tz1delegator1: inclui, identificado como avulso
```

**Borda.** Sem o tipo distinto, um lote manual entra na soma do ciclo e faz a conciliação fechar
errado; com o tipo distinto mas fora do extrato, o delegador reclama de um pagamento que o sistema
diz não existir. Precisa das duas coisas: registrado e classificado.

Borda 2: é por aqui que se liquida a dívida de um delegador que parou de delegar (RN-24). Pagamento
avulso com registro, não transferência fora do sistema.

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

## 1.8 Escopo da instalação

### RN-29 — Uma instância do motor, um baker

**Enunciado.** Uma instância do motor de payout atende exatamente um baker: uma carteira, um banco,
um conjunto de configurações, um agendamento. Operar vários bakers é orquestrar várias instâncias —
**nunca** filtrar por `baker_id` dentro de uma instância compartilhada. *(decidido em DP-13)*

**Exemplo.** Host operando três bakers:

```
/dados/baker-a/   carteira A, banco A, config A   → instância A
/dados/baker-b/   carteira B, banco B, config B   → instância B
/dados/baker-c/   carteira C, banco C, config C   → instância C

nenhuma consulta precisa de WHERE baker_id = ? para estar correta
```

**Por quê.** O isolamento passa a ser por processo e por sistema de arquivos, que é gratuito e não
dá para esquecer, em vez de por predicado de consulta, que dá. Este não é um risco hipotético: hoje
`getPendingRewardsCycle()` consulta o ciclo pendente **sem filtrar por baker**, e numa instalação
compartilhada o job de um baker processaria o ciclo de outro. Com uma instância por baker, essa
classe inteira de bug deixa de existir por construção.

`baker_id` continua nos registros como identificação e auditoria. Deixa de ser chave de isolamento.

**Borda.** Multi-baker é responsabilidade de quem orquestra as instâncias — host, CLI, agendador —
e está **explicitamente fora** do motor. Onde isso importa: uma operação que precise de visão
consolidada entre bakers (relatório agregado, carteira comum) não pertence ao motor e não pode ser
resolvida abrindo uma exceção nesta regra. Consolidação é leitura, e leitura consolidada se faz
fora, sobre os registros de cada instância.

Borda 2: chave de assinatura por instância significa N chaves num host com N bakers. Isso é
requisito de custódia, não detalhe de implantação — é assunto do núcleo criptográfico
(BRES-37 / BRES-41), e a regra aqui não autoriza a saída fácil de passar frase-senha por variável
de ambiente, que é como AI-13 nasceu.

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
| RR-05 | Custo de alocação de conta nova | RN-19 (destinatário não alocado), RN-25 (saldo necessário) |
| RR-06 | Precificação de taxa de rede | RN-04 (custo por transferência), RN-24 (corte relativo) |
| RR-07 | Formatos de endereço válidos e pagáveis | RN-19, RN-23 |
| RR-08 | Saldo *staked* vs *delegated* e o *edge* do baker | RN-03 (duas parcelas; comissão só sobre a delegada) |
| RR-09 | Paginação da API de indexação (recompensas, delegadores) | RN-01, RN-18 (quem entra na apuração) |

Duas consequências que já são certas e valem registrar como restrição de domínio:

1. **A apuração tem duas parcelas, não uma.** Com staking direto, a parcela delegada e a parcela
   stakeada rendem de forma diferente e precisam ser calculadas separadamente. Nenhuma regra deste
   documento assume uma parcela só; RN-03 diz qual delas leva comissão.
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

# Parte 4 — Decisões tomadas

Rafael respondeu as 14 decisões pendentes em **2026-08-30**, acatando as recomendações. Esta parte
deixou de ser lista de perguntas: é o registro do que foi decidido e o ponteiro para a regra que
carrega cada decisão. Onde a decisão criou regra nova, ela está na Parte 1.

| # | Decisão | Onde virou regra |
|---|---|---|
| DP-01 | Valor abaixo do corte vira **dívida acumulada**, não é descartado. Corte relativo ao custo da transferência (K×), configurável. | **RN-24** (nova) |
| DP-02 | A taxa de rede **continua saindo do baker**. Delegador recebe o líquido cheio. | RN-04 |
| DP-03 | A comissão do baker **não entra** na base do bond pool: base = total − bruto dos delegadores. | RN-14 (alterada) |
| DP-04 | Destinatário impagável: **pular e registrar**, valor vira dívida. Exceção: conta não alocada cujo valor cobre o custo de alocação é paga em operação separada. | RN-19 (alterada) |
| DP-05 | Ciclo grande é dividido em **lotes determinísticos**, cada lote persistido com hash antes do envio. | **RN-26** (nova) |
| DP-06 | Existe estado **`parcialmente_pago`** de primeira classe; ciclo parcial bloqueia o seguinte. | **RN-27** (nova) |
| DP-07 | Ciclos devidos formam **fila em ordem**, com limite de segurança que exige confirmação humana. | **RN-28** (nova) |
| DP-08 | **`off` desliga tudo**, inclusive o disparo manual. | RN-08 (alterada) |
| DP-09 | **Não é decisão** — é fato a recuperar. Continua aberta, ver abaixo. | — |
| DP-10 | Lote manual por CSV **entra na trilha**, com tipo de movimento próprio. | RN-21 (alterada) |
| DP-11 | Comissão padrão é **valor vivo**; linha individual só para exceção explícita. Suspender delegador vira estado próprio. | RN-20 (invertida) |
| DP-12 | Comissão incide **só sobre a parcela delegada**; a stakeada é remunerada pelo *edge* do protocolo. | RN-03 (ampliada) |
| DP-13 | **Uma instância, um baker.** Multi-baker é orquestração de host, fora do motor. | **RN-29** (nova) |
| DP-14 | **Sem saldo, não sai nada**: verificação antes de montar o lote, e avisa o que falta. | **RN-25** (nova) |

## O que continua aberto

### DP-09 — O bond pool original pagava todos os membros ou só o gestor?

Não é escolha de produto: é fato a recuperar. O pseudocódigo de `BUSINESS_LOGIC.md` §2.2 ordena os
membros por `is_manager DESC` e faz `break` ao encontrar o gestor — lido literalmente, o laço
encerra na primeira iteração e só o gestor recebe.

Onde verificar: o histórico do git **antes** do commit `9116d30`, que removeu os arquivos
ColdFusion do repositório; ou os pagamentos reais de um baker que usou bond pool.

Enquanto não for verificado, RN-15 e RN-16 descrevem a **intenção documentada**, não o
comportamento observado. Se o comportamento real era pagar só o gestor, isso não muda as regras
acima — muda o que se diz a quem usou o TAPS original.

---

## Critério de pronto

Uma implementação atende esta especificação quando:

1. Todo valor no caminho do dinheiro é inteiro em mutez, do cálculo à assinatura (RN-03, AI-02).
2. Existe teste que **reprova** o pagamento duplicado descrito em RN-11 e passa com RN-12.
3. Nenhuma constante de RR está escrita no código (Parte 2, AI-09/AI-11/AI-12).
4. Nenhum campo de API externa é lido com valor padrão silencioso: campo esperado que não veio é
   erro alto com o nome do campo na mensagem (Parte 2, consequência 2).
5. Toda validação escrita tem um caso que a faz reprovar.
6. `soma paga a um delegador + dívida em aberto dele == soma devida a ele` em todos os ciclos
   (RN-24). Nenhum mutez devido desaparece por ser pequeno.
7. Nenhum destinatário isolado consegue impedir o pagamento dos demais (RN-19), e existe teste com
   um endereço impagável no meio do ciclo que demonstra os outros recebendo.
8. Um ciclo interrompido no meio é representável e visível como tal (RN-27) — nunca reportado como
   `paid` nem como `errors` quando parte do dinheiro já saiu.
9. Nenhuma consulta depende de `WHERE baker_id = ?` para estar correta (RN-29).
