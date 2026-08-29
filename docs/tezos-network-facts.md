# Tezos hoje — levantamento com evidência de rede

Levantamento executado em **2026-08-29** (UTC). Todo número aqui foi lido da rede, não de documentação.
Cada afirmação traz a chamada que a comprova.

> **Isto é um retrato, não uma tabela de constantes.** Os valores mudam a cada upgrade de
> protocolo. O que é permanente é *de onde ler*, não *o que está escrito*.

Vale igual para o **TAPS** e para o **Tezzet** — é conhecimento sobre a rede, independente de stack.

---

## 0. Estado da rede na data do levantamento

| | mainnet | Shadownet | Bakingnet |
|---|---|---|---|
| RPC usado | `https://rpc.tzbeta.net` | `https://rpc.shadownet.teztnets.com` | `https://rpc.bakingnet.teztnets.com` |
| TzKT | `https://api.tzkt.io` | `https://api.shadownet.tzkt.io` | `https://api.bakingnet.tzkt.io` |
| chain id | `NetXdQprcVkpaWU` | `NetXsqzbfFenSTS` | `NetXvNVUNbWHxGt` |
| protocolo | `PsUshuai9QapM5TGj1JpuVGkdxz5GykdnEvS6Rh8SUVrARvZLCY` | idem | idem |
| level / cycle | 14 718 619 / 1337 | 4 838 999 / 378 | 1 995 151 / 554 |
| octez | v25.1 | v25.1 | v25.1 |

```bash
curl -s https://rpc.tzbeta.net/chains/main/blocks/head/protocols
# {"protocol":"PsUshuai9QapM5TGj1JpuVGkdxz5GykdnEvS6Rh8SUVrARvZLCY","next_protocol":"PsUshuai9…"}
```

**As três redes rodam o mesmo protocolo (Ushuaia).** Isso é bom: o que você prova em Bakingnet
vale em mainnet, com uma ressalva importante — ver §1.2.

**Ghostnet não existe.** Confirmado: ausente de `https://teztnets.com/teztnets.json`.
As redes presentes hoje são `mainnet`, `shadownet`, `bakingnet`, `ushuaianet`/`currentnet`,
`snet`, `weeklynet-2026-08-26`.

```bash
curl -s https://teztnets.com/teztnets.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('ghostnet' in d, sorted(d))"
# False ['bakingnet','currentnet','mainnet','shadownet','snet','ushuaianet','weeklynet-2026-08-26']
```

---

## 1. Constantes de protocolo

Fonte única e obrigatória: `GET /chains/main/blocks/head/context/constants`.

### 1.1 O que existe hoje e importa para os dois produtos

| constante | mainnet | Shadownet | Bakingnet | para que serve |
|---|---:|---:|---:|---|
| `blocks_per_cycle` | **14400** | 14400 | **3600** | duração do ciclo |
| `minimal_block_delay` | 6 | 6 | 6 | segundos por bloco (round 0) |
| `delay_increment_per_round` | 3 | 3 | 3 | atraso adicional por round |
| `consensus_rights_delay` | 2 | 2 | 2 | ciclos de antecedência dos direitos |
| `blocks_preservation_cycles` | 1 | 1 | 1 | — |
| `consensus_committee_size` | 7000 | 7000 | 7000 | slots de atestação por bloco |
| `consensus_threshold_size` | 4667 | 4667 | 4667 | quórum (2/3 + 1) |
| `hard_gas_limit_per_operation` | 1 040 000 | idem | idem | teto de gas por operação |
| `hard_gas_limit_per_block` | **1 040 000** | idem | idem | teto de gas por **bloco** |
| `hard_storage_limit_per_operation` | 60 000 | idem | idem | teto de storage |
| `max_operation_data_length` | 32 768 | idem | idem | bytes por operação |
| `max_operations_time_to_live` | **600** | idem | idem | validade do `branch`, em blocos |
| `cost_per_byte` | 250 | 250 | 250 | mutez por byte de storage |
| `origination_size` | 257 | 257 | 257 | bytes cobrados ao alocar conta |
| `edge_of_staking_over_delegation` | **3** | 3 | 3 | peso stake × delegação no poder |
| `global_limit_of_staking_over_baking` | 9 | 9 | 9 | teto de stake externo |
| `limit_of_delegation_over_baking` | 9 | 9 | 9 | teto de delegação |
| `minimal_stake` | 6 000 000 000 | idem | idem | 6000 XTZ para ser baker |
| `minimal_frozen_stake` | 600 000 000 | idem | idem | 600 XTZ congelados |
| `tolerated_inactivity_period` | 2 | 2 | 2 | ciclos até desativar baker |
| `denunciation_period` | 1 | 1 | 1 | janela de denúncia |
| `slashing_delay` | 1 | 1 | 1 | atraso do slash |
| `allow_tz4_delegate_enable` | **true** | true | true | tz4 pode ser baker |
| `aggregate_attestation` | true | true | true | atestações BLS agregadas |
| `tz5_account_enable` | false | false | false | tz5 ainda desligado |

`blocks_per_cycle × minimal_block_delay = 14400 × 6 = 86 400 s` → **um ciclo de mainnet dura
exatamente 1 dia.** Confere com os limites reais do ciclo:

```bash
curl -s "https://api.tzkt.io/v1/cycles?limit=1&sort.desc=index&select=index,startTime,endTime"
# [{"index":1339,"startTime":"2026-08-31T04:06:25Z","endTime":"2026-09-01T04:06:19Z"}]
```

### 1.2 Constante que **difere entre redes** — e por que isso é o argumento inteiro

`blocks_per_cycle` é **14400 em mainnet e Shadownet, mas 3600 em Bakingnet**.

Um código com `BLOCKS_PER_CYCLE` escrito na fonte não erra "um pouco" no testnet do TAPS: erra
por 4×. Todo cálculo derivado de ciclo (janela, agendamento, projeção) sai errado, e sai errado
**silenciosamente**, porque nada na resposta contradiz o valor local.

Esta é a prova prática de que a regra não é estética. Mesmo protocolo, mesma versão do Octez,
constante diferente.

### 1.3 Campos que **deixaram de existir**

Confirmado ausente nas três redes, e confirmado ausente também via Taquito 25.0.0 (§7):

| campo | situação |
|---|---|
| `preserved_cycles` | **removido** — use `consensus_rights_delay`, `blocks_preservation_cycles`, `delegate_parameters_activation_delay`, `unstake_finalization_delay`, `slashing_delay`, `denunciation_period` conforme o caso |
| `endorsers_per_block` | **removido** (Tenderbake) — use `consensus_committee_size` |
| `time_between_blocks` | **removido** (Tenderbake) — use `minimal_block_delay` + `delay_increment_per_round` |
| `blocks_per_roll_snapshot` | removido |
| `tokens_per_roll` | removido — use `minimal_stake` |
| `baking_reward_per_endorsement` | removido — use `issuance_weights` |

```bash
curl -s https://rpc.tzbeta.net/chains/main/blocks/head/context/constants \
 | python3 -c "import json,sys;c=json.load(sys.stdin);print([k for k in ['preserved_cycles','endorsers_per_block','time_between_blocks'] if k in c])"
# []
```

> `TezosClientService.getConstants()` do TAPS lê `constants.time_between_blocks.map(...)` e
> `constants.endorsers_per_block`. `time_between_blocks` é `undefined`; `.map` sobre `undefined`
> **lança**. A função morre na primeira chamada contra qualquer rede atual.

### 1.4 O que ler em execução, e com que cache

| valor | quando reler | cache |
|---|---|---|
| `blocks_per_cycle`, `minimal_block_delay`, `consensus_*`, `edge_of_staking_over_delegation`, `*_limit_*`, `cost_per_byte`, `origination_size`, `max_operations_time_to_live` | por ciclo, ou quando o hash de protocolo mudar | **chave = `(chain_id, protocol_hash)`**, TTL 1 ciclo |
| `protocol` / `next_protocol` (`/chains/main/blocks/head/protocols`) | a cada ciclo | 1 ciclo |
| parâmetros de staking do baker (`active_staking_parameters`) | por ciclo | 1 ciclo |
| gas / storage de um batch (`estimate.batch`) | **toda execução** | nunca |
| saldo do baker antes de pagar | **toda execução** | nunca |

Regra da chave de cache: **incluir o hash de protocolo**. Cache por tempo sobrevive a um upgrade
servindo valor velho; cache por protocolo invalida sozinho no dia da migração.

Se a constante não vier: **erro alto com o nome do campo**. Nunca default.

---

## 2. Contrato atual da TzKT

Endpoint principal: `GET /v1/rewards/split/{baker}/{cycle}`
Baker de referência: `tz1fwnfJNgiDACshK9avfRfFbMaXrs3ghoJa` ("Bake Nug", 2919 delegadores, 75 stakers).
TzKT `1.17.3.0`.

### 2.1 Resposta real (topo, ciclo 1336, lida em 2026-08-29)

```json
{
  "cycle": 1336,
  "ownDelegatedBalance": 931097498,
  "externalDelegatedBalance": 497320419308,
  "delegatorsCount": 2919,
  "ownStakedBalance": 235550399083,
  "externalStakedBalance": 1039802790978,
  "stakersCount": 75,
  "issuedPseudotokens": "818998097843",
  "bakingPower": 1441437028996,
  "totalBakingPower": 442764714958291,
  "blocks": 49,
  "blockRewardsDelegated": 15919946,
  "blockRewardsStakedOwn": 22558860,
  "blockRewardsStakedEdge": 0,
  "blockRewardsStakedShared": 99690382,
  "attestations": 327605,
  "attestationRewardsDelegated": 15313332,
  "attestationRewardsStakedOwn": 21699177,
  "attestationRewardsStakedEdge": 0,
  "attestationRewardsStakedShared": 95891481,
  "dalAttestationRewardsDelegated": 0,
  "missedDalAttestationRewards": 29522460,
  "blockFees": 357034,
  "delegators": [ { "address": "tz1Ysx7W3sNGBijnkpjCvaaJSdKqSAAAiNz2",
                    "delegatedBalance": 43628080517, "emptied": false }, … ],
  "stakers":       [ { "address": "tz1fYw8fgHxREK3bhbhpY88EGa2osRqLEPj1",
                       "stakedPseudotokens": "238191093390", "stakedBalance": 302408228230 }, … ],
  "actualStakers": [ { "address": "tz1fYw8fgHxREK3bhbhpY88EGa2osRqLEPj1",
                       "initialStake": 302531352917, "finalStake": 302588172961,
                       "rewards": 56820044 }, … ]
}
```

### 2.2 Anatomia dos campos de recompensa

Todo campo de recompensa segue o padrão `<evento><Destino>`, com
`evento ∈ {blockRewards, attestationRewards, dalAttestationRewards, vdfRevelationRewards, nonceRevelationRewards}`
e `Destino ∈ {Delegated, StakedOwn, StakedEdge, StakedShared}`.

Descrição oficial (do OpenAPI da própria TzKT) e consequência:

| destino | descrição TzKT | quem recebe | o TAPS precisa pagar? |
|---|---|---|---|
| `…Delegated` | "on baker's **liquid** balance (it is not frozen and can be spent immediately)" | cai líquido no baker | **SIM — é o único pool a distribuir** |
| `…StakedOwn` | "on baker's own staked balance (frozen, belongs to the baker)" | baker, congelado | não |
| `…StakedEdge` | "baker's **edge** from external stake … belongs to the baker" | baker, congelado | não |
| `…StakedShared` | "on baker's external staked balance … belongs to baker's **stakers**" | stakers, **pelo protocolo** | **NÃO — pagar de novo é pagar em dobro** |

Prova de que `StakedShared` já foi pago pelo protocolo — a soma bate na unidade:

```
Σ(actualStakers[].rewards) = 195 581 863
Σ(*StakedShared)           = 195 581 863     diferença: 0
```

> Em um segundo baker (Everstake, 492 `actualStakers` contra `stakersCount` 489) a diferença foi
> de **10 mutez**, porque há stakers que entraram ou saíram durante o ciclo. Ou seja: a igualdade
> é a regra, não uma identidade garantida. Use os campos `*StakedShared`/`*StakedEdge` reportados;
> não reconstrua a partir de `actualStakers`.

### 2.3 Campos legados — presentes, porém marcados `**DEPRECATED**`

A resposta ainda traz `endorsementRewardsDelegated`, `endorsements`, `missedEndorsements`, etc.
O OpenAPI da TzKT os marca `**DEPRECATED**`. São aliases de `attestation*`. **Não os leia.**

### 2.4 O que o TAPS espera × o que a rede devolve — campo a campo

`TzKTClientService.getRewardSplit()` soma oito campos. Conferidos um a um contra a resposta real:

| campo lido pelo TAPS | existe hoje? | efeito com `|| 0` |
|---|---|---|
| `data.ownBlockRewards` | **NÃO** | 0 |
| `data.extraBlockRewards` | **NÃO** | 0 |
| `data.endorsementRewards` | **NÃO** | 0 |
| `data.ownBlockFees` | **NÃO** | 0 |
| `data.extraBlockFees` | **NÃO** | 0 |
| `data.revelationRewards` | **NÃO** | 0 |
| `data.doubleBakingLostRewards` | **NÃO** | 0 |
| `data.doubleEndorsingLostRewards` | **NÃO** | 0 |

**`totalRewards = 0` para todo baker, todo ciclo, sem lançar exceção.**

Da interface `BakerRewards` inteira (46 campos), **34 não existem** na resposta atual —
incluindo `stakingBalance`, `delegatedBalance` e `numDelegators`.

Na entrada de delegador:

| campo lido pelo TAPS | existe hoje? |
|---|---|
| `delegator.address` | sim |
| `delegator.balance` | **não** (o nome é `delegatedBalance`) |
| `delegator.share` | **não** (a API não devolve share pronto) |
| `delegator.reward` | **não** (a API não devolve reward pronto) |

**A API entrega saldos. A divisão é responsabilidade do cliente.**

### 2.5 Paginação — obrigatória

- Limite **padrão: 100**. Máximo: **10 000** (`limit=10001` → HTTP 400,
  `"The field limit must be between 0 and 10000."`).
- Parâmetros: `?limit=&offset=`.

Medido no baker de referência:

| chamada | `delegators` retornados |
|---|---|
| sem `limit` | **100** (de 2919) |
| `?limit=1000` | 1000 |
| `?limit=10000` | 2919 (completo) |

Em um baker grande, `limit=10000` **não basta**. Everstake, ciclo 1336:
`delegatorsCount = 60258`, uma página traz 10 000. Percorrendo com `offset`:

```
offset=0 → 10000 … offset=60000 → 258   total 60258   ✅ == delegatorsCount
```

### 2.6 A validação que consegue reprovar

```
Σ(delegators[].delegatedBalance)  ==  externalDelegatedBalance
```

Este invariante fecha **exatamente** quando a lista está completa, e **falha** quando está truncada:

| baker | páginas | Σ delegatedBalance | externalDelegatedBalance | fecha? |
|---|---|---:|---:|---|
| Bake Nug (2919) | 1 (`limit=10000`) | 497 320 419 308 | 497 320 419 308 | **sim** |
| Everstake (60258) | 1 (`limit=10000`) | 41 707 630 860 806 | 42 162 102 792 867 | **NÃO** — faltam 454 471 932 061 mutez |
| Everstake (60258) | 7 (com `offset`) | 42 162 102 792 867 | 42 162 102 792 867 | **sim** |

Com a lista truncada não há erro nenhum: o pagamento simplesmente **paga a mais** para os 10 000
listados e **paga zero** para os outros 50 258. Rode esse invariante antes de montar qualquer batch;
se falhar, aborte.

Outra checagem viva, no mesmo espírito:

```
bakingPower == ownStaked + externalStaked + (ownDelegated + externalDelegated) / edge_of_staking_over_delegation
```

Confere na unidade em ambos os bakers, com `edge_of_staking_over_delegation = 3` lido da cadeia:

```
Bake Nug : 235550399083 + 1039802790978 + (931097498 + 497320419308)//3 = 1441437028996 == bakingPower ✅
Everstake: … = 28977096919127 == bakingPower ✅
```

Este é o teste que prova que você entendeu o modelo econômico. Se não fechar, a leitura está errada.

### 2.7 O endpoint de delegadores citado na issue **não existe**

```bash
curl -so /dev/null -w "%{http_code}\n" https://api.tzkt.io/v1/delegates/tz1fwnf…/delegators   # 404
curl -so /dev/null -w "%{http_code}\n" "https://api.tzkt.io/v1/delegators?delegate=tz1fwnf…"  # 404
```

Os que existem:

- `GET /v1/accounts/{address}/delegators` → `[{type, address, balance, delegationLevel, delegationTime}]`
- `GET /v1/accounts?delegate={baker}` → conta completa de cada delegador
- **`GET /v1/rewards/split/{baker}/{cycle}`** → é este que traz o saldo **do snapshot do ciclo**, e é
  o único correto para calcular pagamento. Os outros dois trazem saldo **de agora**.

### 2.8 Limites de taxa (uso anônimo)

Medido, não presumido:

| teste | resultado |
|---|---|
| 40 requisições sequenciais (≈1,4 req/s) | 40× 200 |
| 100 requisições, 20 em paralelo | 51× 200, **49× 429** |
| 60 requisições, 30 em paralelo | 25× 200, **35× 429** |

O 429 vem do **nginx**, não da aplicação:

```
HTTP/2 429
content-type: text/html          ← não é JSON
<html><head><title>429 Too Many Requests</title></head>…
```

Consequências para o cliente:

1. **Não há header `Retry-After`** e não há header de quota. Backoff exponencial com jitter, no cliente.
2. **O corpo do 429 é HTML.** Um cliente que faz `JSON.parse` incondicional quebra com erro de
   sintaxe, não com "rate limited" — e o retry vira uma decisão tomada com a mensagem errada.
   Cheque `status` antes de parsear.
3. Serialize as chamadas de payout (concorrência 1–4) e trate 429 como retentável.
4. A TzKT publica os limites vigentes em <https://tzkt.io/api>; o free tier **exige atribuição**
   ("Powered by TzKT API" com link para tzkt.io). Isso é obrigação de licença, não cortesia.

Headers úteis presentes em toda resposta: `tzkt-version`, `tzkt-level`, `tzkt-known-level`,
`tzkt-synced-at`. **Use `tzkt-synced-at` / `tzkt-level`**: um indexador atrasado devolve 200 com
dados velhos.

---

## 3. Adaptive Issuance e staking

### 3.1 Os dois saldos são coisas diferentes

| | `delegated` | `staked` |
|---|---|---|
| custódia | permanece com o dono, líquido | **congelado** no baker |
| risco | nenhum | **sujeito a slashing** junto com o baker |
| peso no poder de baking | `1/3` (`edge_of_staking_over_delegation = 3`) | `1` |
| como o rendimento chega | **o baker precisa pagar** (`*Delegated` cai líquido no baker) | **o protocolo credita sozinho**, compondo no stake |
| taxa do baker | política do baker, off-chain | **`edge_of_baking_over_staking`, on-chain** |
| saída | imediata | `unstake` + `unstake_finalization_delay = 3` ciclos |

Um mesmo endereço pode ser as duas coisas ao mesmo tempo, com saldos distintos.

### 3.2 O edge do baker é on-chain e é por baker

```bash
curl -s https://rpc.tzbeta.net/chains/main/blocks/head/context/delegates/{pkh}/active_staking_parameters
```

Lidos em 2026-08-29:

| baker | `edge_of_baking_over_staking_billionth` | edge | `limit_of_staking_over_baking_millionth` |
|---|---:|---:|---:|
| Ledger by Kiln | 200 000 000 | 20 % | 9 000 000 |
| Everstake | 150 000 000 | 15 % | 5 000 000 |
| Kraken Baker | 100 000 000 | 10 % | 9 000 000 |
| Stake.fish | 80 000 000 | 8 % | 5 000 000 |
| P2P.org | 79 500 000 | 7,95 % | 9 000 000 |
| Bake Nug, Melange | 0 | 0 % | 9 000 000 |

**É `billionth`: divida por 1e9.** Ler como percentual dá 150 000 000 %.
Há também `pending_staking_parameters` — mudanças levam
`delegate_parameters_activation_delay = 5` ciclos para valer.

### 3.3 Como o edge entra na conta

O protocolo aplica o edge **por evento de recompensa**, com arredondamento a cada evento — não
sobre o total do ciclo. Everstake, ciclo 1336, edge 15 %:

```
StakedEdge   =   247 046 406      (reportado)
StakedShared = 1 399 924 931      (reportado)
bruto        = 1 646 971 337
15 % do bruto (total do ciclo) = 247 045 700   →  diferença de 706 mutez
```

**Não recalcule o edge.** Leia `*StakedEdge` e `*StakedShared` da API. Reconstruir a partir da
alíquota erra por centenas de mutez por ciclo, e o erro cresce com o tamanho do baker.

### 3.4 Fórmula de payout

Notação: tudo `bigint`, tudo em mutez. `//` é divisão inteira truncada.

```
EVENTOS = { blockRewards, attestationRewards, dalAttestationRewards,
            vdfRevelationRewards, nonceRevelationRewards }

# 1) o único pool que o baker distribui manualmente
pool_liquido = Σ_{e ∈ EVENTOS} split[e + "Delegated"]

# 2) taxas de bloco: política do baker (incluir ou não). Se incluir:
#    pool_liquido += split["blockFees"]

# 3) parte que corresponde ao saldo delegado do próprio baker — ele fica com ela
base       = split.ownDelegatedBalance + split.externalDelegatedBalance
parte_own  = pool_liquido * split.ownDelegatedBalance // base
bruto_ext  = pool_liquido - parte_own

# 4) taxa do baker sobre delegação — racional inteiro, nunca float
taxa       = bruto_ext * FEE_NUM // FEE_DEN
pagavel    = bruto_ext - taxa

# 5) rateio proporcional, floor, sempre para baixo
para cada d em delegators (lista COMPLETA, ver §2.5):
    valor[d] = pagavel * d.delegatedBalance // split.externalDelegatedBalance

# 6) sobra de arredondamento fica com o baker — nunca se inventa mutez
sobra = pagavel - Σ valor[d]

# invariante que precisa fechar:
parte_own + taxa + Σ valor[d] + sobra == pool_liquido
```

**Stakers não entram nesta conta.** `*StakedShared` já foi creditado pelo protocolo (§2.2).
`*StakedOwn` e `*StakedEdge` são do baker. Pagar qualquer um dos três é pagamento duplicado.

### 3.5 Exemplo numérico que fecha

Bake Nug, ciclo 1336, mainnet, taxa do baker 10 % (`FEE_NUM/FEE_DEN = 10/100`):

```
pool_liquido  Σ(*Delegated)                                =   31 233 278
blockFees                          (baker fica)            =      357 034
Σ(*StakedOwn)                      (baker, congelado)      =   44 258 037
Σ(*StakedEdge)                     (edge = 0)              =            0
Σ(*StakedShared)                   (protocolo já pagou)    =  195 581 863   ← NÃO pagar

ownDelegatedBalance                                        =      931 097 498
externalDelegatedBalance                                   =  497 320 419 308
base                                                       =  498 251 516 806

parte_own  = 31 233 278 *      931 097 498 // 498 251 516 806 =       58 366
bruto_ext  = 31 233 278 - 58 366                             =   31 174 912
taxa 10 %  = 31 174 912 * 10 // 100                          =    3 117 491
pagavel                                                      =   28 057 421

Σ valor[d]  (2919 delegadores, floor)                        =   28 056 046
sobra                                                        =        1 375

CHECK: 58 366 + 3 117 491 + 28 056 046 + 1 375 = 31 233 278 == pool_liquido  ✅
```

Três maiores delegadores:

| endereço | `delegatedBalance` | recebe |
|---|---:|---:|
| `tz1Ysx7W3sNGBijnkpjCvaaJSdKqSAAAiNz2` | 43 628 080 517 | 2 461 373 mutez (2,461373 XTZ) |
| `tz1Pp56sn9r2jNwN9YwwvTYWHmrpfqeHUFgj` | 26 756 730 648 | 1 509 539 mutez |
| `tz1a4XMNsQgtw5i5PJ2ifQ9wWWJ6cbdEPLsx` | 26 004 049 076 | 1 467 075 mutez |

### 3.6 Valor mínimo de pagamento — a conta que decide

Custo real de uma transferência hoje (§5): **≈545 mutez** de taxa, mais **64 250 mutez** de burn
se a conta de destino não estiver alocada.

Mesmo ciclo, mesmo baker:

| corte | delegadores pagos | taxa total | % do pool | não distribuído |
|---:|---:|---:|---:|---:|
| 0 (todos) | 2645 | 1 441 525 | 5,14 % | 1 374 |
| 545 (= 1 taxa) | 1028 | 560 260 | 2,00 % | 158 452 |
| 5 450 | 382 | 208 190 | 0,74 % | 1 425 046 |
| 100 000 (0,1 XTZ) | 46 | 25 070 | 0,09 % | 9 618 295 |

**2092 dos 2919 delegadores (72 %) receberiam menos do que custa mandar o pagamento.**
274 recebem exatamente 0. Sem valor mínimo, 5,14 % do pool vira taxa. Com corte em uma taxa,
2,00 %. O corte é decisão de política — mas ele **precisa existir**, e o saldo não pago precisa
acumular para o ciclo seguinte, não sumir.

### 3.7 Quando a recompensa do ciclo fica pronta

Medido:

| ciclo | `futureBlocks` | `Σ *Delegated` | estado |
|---|---:|---:|---|
| 1338 | 52 | 0 | futuro |
| 1337 | 10 | 13 768 337 | em andamento |
| 1336 | 0 | 31 233 278 | **fechado** |
| 1335 | 0 | 31 602 057 | fechado |

E o crédito acontece **no último bloco do ciclo**:

```bash
curl -s "https://api.tzkt.io/v1/operations/attestation_rewards?baker=tz1fwnf…&limit=1&sort.desc=id"
# [{"level":14707488,"timestamp":"2026-08-29T04:00:46Z","rewardDelegated":15313332, …}]
# cycle 1336 lastLevel = 14707488 ; cycle 1337 firstLevel = 14707489
# rewardDelegated 15313332 == attestationRewardsDelegated do ciclo 1336
```

**`CYCLES_UNTIL_DELIVERED = 5` está errado.** A recompensa do ciclo N é creditada no último bloco
do ciclo N — hoje, ~5 dias antes do que o TAPS assume.

A espera que ainda faz sentido é outra e é menor: `denunciation_period = 1` e `slashing_delay = 1`
significam que uma denúncia de double-baking do ciclo N ainda pode reduzir o valor durante o ciclo
N+1. **Distribua o ciclo N depois que o ciclo N+2 começar**, e releia o split antes de montar o
batch. Um ciclo de espera, não cinco.

Detalhe correlato: o snapshot de stake do ciclo N é o último bloco do ciclo N−3
(`cycles?index=1339` → `snapshotLevel = 14707488` = último bloco de 1336).

---

## 4. Endereços tz4 (BLS)

### 4.1 Estado na rede

| evidência | resultado |
|---|---|
| `allow_tz4_delegate_enable` nas constantes de mainnet | **`true`** |
| `aggregate_attestation` | `true` |
| bakers ativos em mainnet, por prefixo (`/context/delegates?active=true`) | tz1: 173, tz3: 19, tz2: 3, **tz4: 2** |
| tz4 bakando hoje | `tz4TUryBw8kUQm7ScAtMx6FhBH5WswY1TZrE`, `tz4HDE8tkWgCj2YC4y95W77t3sGP1tZhKPoi` |
| chave pública desse baker | `BLpk1r6M9otWHSqiX4w3Bs9ApyhGxvYDjH8Ctj…` (BLS), 170 blocos, 988 602 atestações |
| `consensusAddress` / `companionAddress` de bakers tz1 | **são tz4** (ex.: `tz4DpBeqtimtqL9nfhfS8uEbkHHwXsSDNUjE`) |
| tz4 entre delegadores/stakers de 4 bakers grandes (72 346 contas) | **0** |

Leitura honesta: **tz4 já é cidadão de primeira classe da rede** (bakers ativos, chaves de consenso
e companion), mas **hoje não há delegador tz4** na amostra. O risco é de compatibilidade futura,
não perda em curso.

### 4.2 Pagar para tz4 funciona — simulado em mainnet

```
POST /chains/main/blocks/head/helpers/scripts/simulate_operation
destino tz4ANnkPhib6RzUH4TnHfvpvtsM2vZJbuFGp (tz4 novo, não alocado)
→ status: applied | consumed_milligas: 2 168 788 | allocated_destination_contract: true
```

**Mesmo gas de um tz1.** A cadeia não faz distinção. A rejeição é 100 % client-side.

### 4.3 O que muda no código

`TEZOS_CONSTANTS.ADDRESS_PATTERNS` do TAPS tem `TZ1`, `TZ2`, `TZ3`, `KT1` — e nada mais.
`isValidTezosAddress('tz4…')` retorna `false`, em `wallet.service.ts:116` e em
`reward-validator.service.ts` (linhas 61 e 123). Um delegador tz4 é reprovado na validação
e não entra no batch.

O comprimento não é o problema: tz1, tz2, tz3, tz4 e KT1 têm todos **36 caracteres**, então o
`{33}` do regex serviria. O que falta é só o prefixo `tz4`. Mesmo assim, não conserte com regex.

**Correção:** não escreva regex de endereço. Use `validateAddress` do `@taquito/utils`, que já
trata prefixo, comprimento e **checksum** — coisa que nenhum dos regex faz (§7.2).

---

## 5. Gas, taxas e storage — números reais

### 5.1 Transferência simples, medida na cadeia

Simulação contra mainnet (`simulate_operation`, sem injetar nada):

| cenário | `storage_limit` | resultado | milligas |
|---|---:|---|---:|
| destino já existente | 0 | **applied** | 2 168 788 (≈ **2169 gas**) |
| destino **não alocado** | 0 | **backtracked** — `proto.025-PsUshuai.storage_exhausted.operation` | 2 168 788 |
| destino **não alocado** | 257 | **applied** | 2 168 821 |
| destino **tz4** não alocado | 300 | **applied** | 2 168 788 |

Amostra de 200 transações reais recentes: `gasUsed` de transferência tz→tz é
**2100 / 2101 / 2155 / 2169**. `bakerFee` observada: 0 a 1420 mutez, típica 500–650.
Batches de payout reais em mainnet (60–68 operações) mostram **média 545 mutez/transferência**.

| valor no TAPS | valor real | fator |
|---|---|---|
| `DEFAULT_GAS_LIMIT = 15400` | ~2169 | **7,1× a mais** |
| `DEFAULT_TRANSACTION_FEE = 0.0018` XTZ = 1800 mutez | ~545 | **3,3× a mais** |

Gas superdimensionado não é só caro: ele **encolhe o batch**, porque o limite é por bloco (§5.3).

### 5.2 `storageLimit: 0` derruba o batch inteiro — provado

`transaction.service.ts:182` fixa `storageLimit: 0` com o comentário
*"No storage needed for simple transfers"*. Simulação de um batch de 3 transferências em mainnet:

```
batch A — dois destinos existentes + um não alocado, todos storage_limit=0
  op1 tz1Ysx7W3sNGBi  status=backtracked   errors=[]
  op2 tz1Pp56sn9r2jN  status=backtracked   errors=[]
  op3 tz1ZN92Qc94gwQ  status=backtracked   errors=['proto.025-PsUshuai.storage_exhausted.operation']

batch B — idêntico, mas storage_limit=257 na conta nova
  op1 applied   op2 applied   op3 applied
```

**Um delegador com conta não alocada zera a distribuição do ciclo inteira**, e os outros dois
recipients aparecem como `backtracked` sem erro próprio — o diagnóstico não fica óbvio no log.

O burn é `origination_size × cost_per_byte = 257 × 250 = **64 250 mutez**`, confirmado em
transações reais (`allocationFee: 64250`). Quem paga é a **origem** — o baker.

O campo `emptied` do `SplitDelegator` existe exatamente para isso: *"Emptied accounts (users with
zero balance) should be re-allocated"*. Leia-o, e some 257 ao `storage_limit` de quem estiver
`emptied` ou nunca alocado. Melhor ainda: use o `storage_limit` que a estimativa devolver.

### 5.3 Tamanho de batch — o teto real é por bloco

`hard_gas_limit_per_block == hard_gas_limit_per_operation == 1 040 000`.
A **soma** dos `gas_limit` do batch precisa caber no bloco. Prova:

```
batch de 3 transferências com gas_limit=1040000 cada:
[{"kind":"permanent","id":"proto.025-PsUshuai.gas_limit_too_high"},
 {"kind":"temporary","id":"proto.025-PsUshuai.gas_exhausted.block"}]
```

Com o gas real de 2169:

| gas_limit por operação | operações que cabem em 1 bloco |
|---:|---:|
| 1 040 000 (default cego do Taquito) | **1** |
| 15 400 (`DEFAULT_GAS_LIMIT` do TAPS) | 67 |
| 2 500 (estimado + margem) | 416 |

Segundo teto: `max_operation_data_length = 32 768` bytes por operação.
Terceiro: `MAX_BATCH_SIZE = 100` no TAPS — razoável, mas os batches reais de mainnet ficam em
**60–68 operações**, o que também é uma boa referência. Um batch de 479 consumiria o bloco inteiro
e competiria com todo o resto da rede.

**Regra:** uma chamada `estimate.batch()`, use `gasLimit`/`storageLimit`/`fee` que ela devolver,
some e valide contra `hard_gas_limit_per_block` lido da cadeia. Se estourar, divida.

### 5.4 `tezToMutez` com float — o erro medido

```ts
export function tezToMutez(tez: number): number {
  return Math.floor(tez * TEZOS_CONSTANTS.MUTEZ_PER_TEZ);
}
```

Varrendo 200 000 valores de 0,00001 a 2 XTZ com 5 casas decimais: **2309 valores (1,15 %) saem
1 mutez a menos**. Exemplos: `0.00397 → 3969` (correto 3970), `0.00399 → 3989`, `0.00785 → 7849`.

O erro é sistemático e **sempre para baixo**. Em uma distribuição de 2919 delegadores repetida
todo ciclo, isso é perda contínua e não reconciliável.

> Nota: `Math.floor(0.29 * 1e6)` dá 290000 — esse caso específico não quebra. A classe do bug é
> real; o exemplo canônico é `0.00397`.

**Correção:** nunca converta com float. Trabalhe em `bigint`/mutez de ponta a ponta e formate em
XTZ só na borda de exibição. Para entrada decimal use string:
`BigInt(new Decimal(s).mul(1_000_000).toFixed(0))`. Taquito 25 já expõe
`format('tz','mutez', valor)`, que aceita string e devolve `BigNumber` (§7.3).

---

## 6. Confirmação de operação com Tenderbake

### 6.1 Por que "esperar N blocos" não é a resposta

Tenderbake dá **finalidade determinística**. Um bloco no nível L está decidido quando existe um
bloco em L+1 construído sobre ele, porque L+1 carrega o quórum de atestações de L:
`consensus_threshold_size = 4667` de `consensus_committee_size = 7000` (2/3 + 1). Reverter L
exigiria que ≥ 1/3 do comitê assinasse dois blocos no mesmo nível — o que é **denunciável e
slashable** (`max_slashing_threshold = 1/3`,
`percentage_of_frozen_deposits_slashed_per_double_baking = 500` ‱).

`DEFAULT_CONFIRMATION_BLOCKS = 8` no TAPS é herança de Emmy*, onde a finalidade era probabilística.
Hoje 8 blocos ≈ 48 s de espera para uma garantia que já existia aos 12 s. Não é inseguro — é
inútil, e atrasa a detecção de falha.

### 6.2 O critério correto

Uma operação está **confirmada** quando:

1. ela está incluída em um bloco de nível `L`; **e**
2. `head.level >= L + 2`; **e**
3. **relendo agora**, ela continua no bloco `L` com o mesmo hash de bloco e `status == "applied"`.

O passo 3 é o que importa. Não conte blocos: **releia a operação pelo hash**. Contar blocos assume
que a cadeia que você viu é a cadeia que ficou; reler verifica.

### 6.3 O critério de desistir — e é aqui que a idempotência nasce

`max_operations_time_to_live = 600` blocos × 6 s = **exatamente 1 hora**.

Passadas 600 blocos do `branch` usado, a operação **não pode mais ser incluída**, nunca. Este é o
único ponto em que "não foi injetada" é uma afirmação segura. Antes disso, ausência do mempool não
prova nada.

Máquina de estados de um pagamento:

| estado | como se verifica |
|---|---|
| `pending` | `opHash` gravado **antes** de injetar; ainda não visto em bloco |
| `included` | achado em bloco `L`, `status=applied` |
| `confirmed` | `head.level >= L+2` **e** releitura confirma bloco e status |
| `failed` | achado em bloco com `status != applied` |
| `expired` | `head.level > branch_level + 600` e nunca apareceu → **seguro reenviar** |

Nunca reenviar em `pending`. Nunca apagar o registro da tentativa anterior — o `opHash` é a única
prova de que o dinheiro pode já ter saído.

### 6.4 Como consultar um `opHash`

```bash
curl -s "https://api.tzkt.io/v1/operations/{hash}/status"
# aplicada  → HTTP 200, corpo: true
# rejeitada → HTTP 200, corpo: false
# nunca vista → HTTP 204, CORPO VAZIO      ← não é 404
```

**204 com corpo vazio quebra um `JSON.parse` incondicional.** Trate 204 explicitamente como
"desconhecida", não como erro nem como "não paga".

Detalhes completos (nível, hash do bloco, status, counter) em `GET /v1/operations/{hash}`:

```json
[{"type":"transaction","hash":"opCdNE9wDRzYxKKRYuqxawTtzScJFFauXihZa7aszBHqpuZyFsk",
  "level":14718736,"block":"BL6qFDjSTDgC76dZVggrpyDenRVCzY1pcvQqGzSVe7DKQt9Qqnt",
  "timestamp":"2026-08-29T22:51:07Z","status":"applied","counter":97949834}]
```

Pela RPC, a verificação equivalente e independente de indexador:
`GET /chains/main/blocks/{L}/operation_hashes` e `GET /chains/main/blocks/head/header`.

**Trave adicional barata:** o `counter` da conta de origem é estritamente crescente e único por
operação. Persista `(cycle, counter, opHash)` antes de injetar. Se o counter já foi consumido na
cadeia, a operação já entrou — não reenvie.

---

## 7. Taquito — versão verificada

**`@taquito/taquito@25.0.0`**, publicada em **2026-06-29**. `latest` no npm em 2026-08-29.
Verificado instalando e executando, não presumido.

### 7.1 Conhece o protocolo em produção

```
Protocols.PsUshuai9 = PsUshuai9QapM5TGj1JpuVGkdxz5GykdnEvS6Rh8SUVrARvZLCY   ✅ (= mainnet hoje)
```

### 7.2 Valida tz4

```
validateAddress('tz4TUryBw8kUQm7ScAtMx6FhBH5WswY1TZrE') → 3 (VALID)
validateKeyHash('tz4TUryBw8kUQm7ScAtMx6FhBH5WswY1TZrE') → 3 (VALID)
validateAddress('tz1invalidaddresshere00000000000000000') → não-VALID (checksum)
```

`@taquito/utils` 25 expõe `PrefixV2.BLS12_381PublicKeyHash`, `encodeBlsAddress`,
`b58DecodeBlsAddress` — suporte BLS de primeira classe.

> **Quebra de API na v25:** `prefix` e `Prefix` foram substituídos por `PrefixV2`, e `b58cencode`
> por `b58Encode`. Código escrito para Taquito ≤ 24 não compila. Vale para os dois repos.

### 7.3 Lê as constantes atuais corretamente

`TezosToolkit('https://rpc.tzbeta.net').rpc.getConstants()` devolve, tipado e correto:
`blocks_per_cycle=14400`, `consensus_rights_delay=2`, `minimal_block_delay=6`,
`consensus_committee_size=7000`, `consensus_threshold_size=4667`,
`hard_gas_limit_per_operation=1040000`, `hard_gas_limit_per_block=1040000`,
`max_operations_time_to_live=600`, `cost_per_byte=250`, `origination_size=257`,
`edge_of_staking_over_delegation=3`, `minimal_stake=6000000000`.

E `preserved_cycles`, `endorsers_per_block`, `time_between_blocks` vêm `undefined` — Taquito não
inventa valor. Quem inventa é o `|| 0` do chamador.

`format('tz','mutez','0.29')` aceita string e devolve `BigNumber` — use a forma string.

**Veredito: Taquito 25.0.0 suporta o modelo atual.** Não há impedimento de biblioteca. O problema
está inteiramente no código que a usa.

---

## 8. O que o TAPS assume × o que a rede faz

| # | TAPS | rede hoje | consequência |
|---|---|---|---|
| 1 | `BLOCKS_PER_CYCLE = 4096` | 14400 (mainnet/Shadownet), **3600** (Bakingnet) | toda janela de ciclo errada; erra por 4× no próprio testnet |
| 2 | `CYCLES_UNTIL_DELIVERED = 5` | recompensa creditada no **último bloco do ciclo N** | paga ~5 dias tarde |
| 3 | `DEFAULT_GAS_LIMIT = 15400` | ~2169 medido | 7,1× a mais; encolhe o batch de 416 para 67 |
| 4 | `DEFAULT_TRANSACTION_FEE = 0.0018` XTZ | ~545 mutez medido | 3,3× a mais, todo pagamento |
| 5 | `DEFAULT_CONFIRMATION_BLOCKS = 8` | finalidade em 2 blocos + releitura | espera inútil; e contar blocos não é o teste certo |
| 6 | `constants.time_between_blocks.map(...)` | campo **removido** | `TypeError` — `getConstants()` não roda |
| 7 | `constants.endorsers_per_block` | campo **removido** | `undefined` |
| 8 | `data.ownBlockRewards \|\| 0` (+7 campos) | **8 de 8 ausentes** | `totalRewards = 0`, sem erro |
| 9 | interface `BakerRewards` (46 campos) | **34 ausentes** | objeto quase todo zerado |
| 10 | `delegator.balance / .share / .reward` | só `address`, `delegatedBalance`, `emptied` | rateio impossível como escrito |
| 11 | lê `delegators` sem `limit`/`offset` | padrão 100, máx 10 000 | Everstake: 10 000 de 60 258 |
| 12 | `validateCalculation()` com `bakerShare = total − pagamentos` | — | condição trivialmente verdadeira; nunca reprova |
| 13 | `ADDRESS_PATTERNS` sem `tz4` | tz4 ativo; 2 bakers tz4 em mainnet | delegador tz4 reprovado; pagamento a tz4 funciona na cadeia |
| 14 | regex de endereço, sem checksum | — | aceita endereço com dígito trocado |
| 15 | `storageLimit: 0` fixo no batch | conta nova exige 257 | **um destinatário derruba o batch inteiro** (provado) |
| 16 | `tezToMutez` com `Math.floor(tez*1e6)` | — | 1,15 % dos valores perdem 1 mutez, sempre para baixo |
| 17 | ignora `staked_balance` / `edge` | dois saldos, dois regimes | `*StakedShared` já foi pago pelo protocolo — pagar = pagar em dobro |
| 18 | sem valor mínimo de pagamento | taxa 545 mutez/destinatário | 72 % dos delegadores recebem menos do que custa pagá-los |
| 19 | sem checagem de saldo antes do batch | — | batch falha no meio |
| 20 | `@@unique([bakerId, cycle, date, result])` | — | permite duplicar o mesmo ciclo |
| 21 | retry reenvia sem consultar `opHash`; `clearPreviousAttempt()` apaga o registro | `max_operations_time_to_live = 600` blocos = 1 h | pagamento duplicado; e apaga a única prova |
| 22 | sem tratar 429 | 429 do nginx, corpo **HTML**, sem `Retry-After` | `JSON.parse` quebra com erro errado |

---

## 9. Checklist para quem for implementar

**Constantes**
- [ ] `getConstants()` da RPC, cache com chave `(chain_id, protocol_hash)`, TTL 1 ciclo.
- [ ] Zero constante de protocolo no código. `BLOCKS_PER_CYCLE`, `CYCLES_UNTIL_DELIVERED`, `DEFAULT_GAS_LIMIT` saem.
- [ ] Campo esperado ausente → erro alto com o nome do campo. Nunca `|| 0`, nunca default.

**TzKT**
- [ ] Paginar `?limit=10000&offset=` até a página vir incompleta.
- [ ] Invariante `Σ delegators[].delegatedBalance == externalDelegatedBalance` — **aborta se falhar**.
- [ ] Invariante `bakingPower == staked + delegated / edge_of_staking_over_delegation`.
- [ ] Só campos `attestation*`; nunca os `endorsement*` marcados DEPRECATED.
- [ ] Checar `status` antes de `JSON.parse`; 429 → backoff exponencial com jitter; 204 → "desconhecida".
- [ ] Conferir `tzkt-synced-at` / `tzkt-level` antes de confiar no dado.
- [ ] Exibir "Powered by TzKT API" com link (exigência do free tier).

**Dinheiro**
- [ ] `bigint` em mutez de ponta a ponta; formatação XTZ só na borda de exibição.
- [ ] Distribuir **apenas** `Σ(*Delegated)`. Nunca `*StakedShared`, `*StakedOwn`, `*StakedEdge`.
- [ ] Taxa como racional inteiro (`num/den`), nunca float.
- [ ] Rateio com floor; sobra fica com o baker; invariante da §3.4 fecha em teste.
- [ ] Valor mínimo de pagamento configurável; saldo abaixo do corte acumula para o ciclo seguinte.
- [ ] Distribuir o ciclo N só depois que N+2 começar (janela de denúncia), relendo o split.

**Batch**
- [ ] Uma chamada `estimate.batch()`; usar `gasLimit`/`storageLimit`/`fee` retornados.
- [ ] `storage_limit` nunca fixo em 0; contas `emptied`/novas precisam de ≥ 257.
- [ ] Validar `Σ gas_limit <= hard_gas_limit_per_block` lido da cadeia; dividir se estourar.
- [ ] Verificar saldo do baker ≥ Σ valores + Σ taxas + burns antes de assinar.
- [ ] Registrar qual lote já foi enviado, com `opHash`, antes de mandar o próximo.

**Idempotência**
- [ ] Persistir a intenção com `(cycle, counter, opHash)` **antes** de injetar.
- [ ] Nunca reenviar sem consultar o estado on-chain do `opHash` anterior.
- [ ] Só tratar como não injetada depois de `branch_level + 600`.
- [ ] `@@unique([bakerId, cycle])` no banco.
- [ ] Teste que roda a distribuição duas vezes e prova que paga uma só.

**Endereços**
- [ ] `validateAddress` do `@taquito/utils`; apagar `ADDRESS_PATTERNS`.
- [ ] tz1, tz2, tz3, **tz4**, KT1 aceitos.

**Confirmação**
- [ ] Confirmado = incluído em `L` **e** `head >= L+2` **e** releitura confirma bloco e status.
- [ ] `DEFAULT_CONFIRMATION_BLOCKS` sai.

---

## Apêndice — como reproduzir

```bash
# rede e protocolo
curl -s https://teztnets.com/teztnets.json
curl -s https://rpc.tzbeta.net/chains/main/blocks/head/protocols
curl -s https://rpc.tzbeta.net/chains/main/blocks/head/context/constants
curl -s https://rpc.shadownet.teztnets.com/chains/main/blocks/head/context/constants
curl -s https://rpc.bakingnet.teztnets.com/chains/main/blocks/head/context/constants

# bakers e tz4
curl -s "https://rpc.tzbeta.net/chains/main/blocks/head/context/delegates?active=true"
curl -s https://rpc.tzbeta.net/chains/main/blocks/head/context/delegates/{pkh}/active_staking_parameters

# recompensas e paginação
curl -s "https://api.tzkt.io/v1/rewards/split/tz1fwnfJNgiDACshK9avfRfFbMaXrs3ghoJa/1336?limit=10000"
curl -s "https://api.tzkt.io/v1/rewards/split/tz1aRoaRhSpRYvFdyvgWLL6TGyRoGF51wDjM/1336?limit=10000&offset=0"
curl -s "https://api.tzkt.io/v1/cycles?limit=3&sort.desc=index"
curl -s "https://api.tzkt.io/v1/operations/attestation_rewards?baker={pkh}&limit=3&sort.desc=id"

# simulação de batch (nada é injetado)
curl -s -X POST -H 'Content-Type: application/json' -d @req.json \
  "https://rpc.tzkt.io/mainnet/chains/main/blocks/head/helpers/scripts/simulate_operation?version=1"
# req.json = {"operation":{"branch":"<head hash>","contents":[{"kind":"transaction","source":"<baker>",
#   "fee":"0","counter":"<counter+1>","gas_limit":"3000","storage_limit":"0","amount":"1000000",
#   "destination":"<dest>"}]},"chain_id":"NetXdQprcVkpaWU"}
# nota: rpc.tzbeta.net devolve 401 nos endpoints helpers/scripts para uso anônimo.
```

---

**Ghostnet não existe.** Testes da suíte: **Shadownet** para o Tezzet (aplicação),
**Bakingnet** para o TAPS (baker) — o registro do Shadownet pede explicitamente que bakers não
sejam testados nele. RPC e endpoint de TzKT por produto vêm de configuração, nunca do código.

Mainnet que move fundos reais é decisão humana, toda vez.
