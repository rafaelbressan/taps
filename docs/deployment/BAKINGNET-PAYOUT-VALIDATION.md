# Validação do payout em Bakingnet

O que falta para fechar o último critério do BRES-46: **payout completo em Bakingnet
conferido contra a cadeia, mutez a mutez**.

O harness do BRES-44 já sabe rodar o motor de produção (`--engine taps`), e o motor
recusa subir sem signer. Falta a metade que só quem tem o host pode fazer: **subir o
`octez-signer` e financiar a chave**.

> **Os valores não existem em lugar nenhum ainda. Você os cria.** Não há onde
> procurá-los: `TAPS_SIGNER_URL` é o endereço que você escolhe para o daemon,
> `TAPS_SIGNER_PKH` é o endereço de uma chave que você gera,
> `TAPS_SIGNER_CLIENT_AUTH_KEY` é a chave de cliente que você gera, e o `octez-signer`
> é um binário que você sobe. Os comandos abaixo produzem todos.

**Tudo aqui foi executado de verdade contra `octez-signer` 25.1**, e as versões
anteriores deste documento estavam erradas em dois pontos — ver "O que mudou" no fim.

---

## Parte 1 — Sua metade

Nada de Tezos precisa estar instalado. Tudo roda pela imagem oficial:

```bash
docker pull tezos/tezos:latest
mkdir -p ~/taps-signer/data ~/taps-signer/client
```

### 1.1 A chave de payout — vira o `TAPS_SIGNER_PKH`

É a chave do baker de testes. Ela nasce **dentro do host do signer** e nunca sai dali.

```bash
docker run --rm -v ~/taps-signer/data:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data gen keys payout

docker run --rm -v ~/taps-signer/data:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data show address payout
```

Sai algo assim:

```
Hash: tz1P3fJFGgbGnBNeZeSfHz5NEFzFe2aRqZBv     ← este é o TAPS_SIGNER_PKH
Public Key: edpku9114QhK...
```

Financie esse `tz1...` no faucet: <https://faucet.bakingnet.teztnets.com>. Uns 8 000 ꜩ
cobrem o cenário com folga.

### 1.2 A chave de cliente — vira o `TAPS_SIGNER_CLIENT_AUTH_KEY`

O signer roda com `--require-authentication`: ele só atende quem assina o pedido com uma
chave que ele conhece. Essa chave **não move dinheiro** — ela só diz *quem está pedindo*.

```bash
docker run --rm -v ~/taps-signer/client:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data gen keys client

cat ~/taps-signer/client/public_keys   # o edpk... — vai para o signer
cat ~/taps-signer/client/secret_keys   # o edsk... — vai para o host do TAPS
```

Autorize a pública no signer:

```bash
docker run --rm -v ~/taps-signer/data:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data add authorized key <edpk-do-cliente>
```

O `edsk` do cliente (sem o prefixo `unencrypted:`) vira o `TAPS_SIGNER_CLIENT_AUTH_KEY`
no host do TAPS. **A chave de payout continua sem sair do host do signer** — são chaves
diferentes, e é essa separação que a opção A protege.

### 1.3 O certificado TLS — vira o `TAPS_SIGNER_URL`

O signer serve esta API **só por TCP**, e HTTP em claro é proibido pela decisão de
custódia. Então TLS, com certificado próprio:

```bash
cd ~/taps-signer
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout tls.key -out tls.crt \
  -subj "/CN=taps-signer" \
  -addext "subjectAltName=DNS:taps-signer,DNS:localhost,IP:127.0.0.1"
```

Se o signer for rodar em outra máquina, troque o `subjectAltName` pelo IP ou nome que a
máquina do harness vai usar (o IP da Tailscale, por exemplo).

### 1.4 Subir o daemon

```bash
docker run -d --name taps-signer -p 6732:6732 \
  -v ~/taps-signer/data:/data \
  -v ~/taps-signer/tls.crt:/tls.crt:ro \
  -v ~/taps-signer/tls.key:/tls.key:ro \
  --entrypoint octez-signer tezos/tezos:latest \
  -d /data --require-authentication launch https signer /tls.crt /tls.key \
  --address 0.0.0.0 --port 6732 --magic-bytes 0x03

docker logs taps-signer     # deve dizer "accepting HTTPS requests on port 6732"
```

`--require-authentication` é o que faz o signer recusar qualquer processo que não seja o
TAPS, mesmo com acesso à porta. `--magic-bytes 0x03` é o que faz o signer recusar
cabeçalho de bloco e attestation: com
ele, um host comprometido do TAPS não arranca do signer nada além de uma operação
genérica — e o destino dessa operação é conferido do lado do TAPS, contra a lista de
delegadores calculada localmente, antes de a assinatura ser pedida.

O que **não** pode entrar na linha de comando:

| Opção | Por quê |
|---|---|
| `--password-filename` | recria, no host do signer, o defeito que a opção A elimina |
| `--allow-list-known-keys` | expõe quais chaves o signer guarda |
| `--allow-to-prove-possession` | não é necessário para payout |
| `launch http signer` | corpo em claro; o corpo são os bytes que movem dinheiro |

### 1.5 O que me mandar

```
TAPS_SIGNER_URL=https://<host-ou-ip>:6732
TAPS_SIGNER_PKH=tz1...            (o do passo 1.1, já financiado)
TAPS_SIGNER_CLIENT_AUTH_KEY=edsk...   (o secret do passo 1.2 — o do CLIENTE)
```

Mais o **conteúdo do `tls.crt`** (é público — é o certificado, não a chave). Sem ele o
Node recusa o certificado próprio.

**A chave de payout (o `edsk` do baker) não vem no comentário.** Se vier, a opção A
deixou de valer e a chave precisa ser rotacionada. O `edsk` do **cliente** vem — ele não
assina transferência nenhuma, só prova quem está pedindo.

---

## Parte 2 — Minha metade

```bash
export TEZOS_NETWORK=bakingnet
export TEZOS_RPC_URL=https://rpc.bakingnet.teztnets.com
export TZKT_API_URL=https://api.bakingnet.tzkt.io

export TAPS_SIGNER_URL=https://<host>:6732
export TAPS_SIGNER_PKH=tz1...
export TAPS_SIGNER_CLIENT_AUTH_KEY=edsk...
export NODE_EXTRA_CA_CERTS=/caminho/para/tls.crt

# Teto por ciclo, em mutez. Sem ele o processo recusa subir. O pool sintético
# padrão do harness é 400 000 000, então 500 000 000 cobre a corrida.
export TAPS_PAYOUT_CYCLE_CAP_MUTEZ=500000000

# K da RN-24: o corte é K x o custo estimado da própria transferência.
# Escolhido em 2026-09-06 (BRES-83). O harness assume 1 se você não passar,
# que era o comportamento anterior a K existir — passe 2 para a corrida provar
# a política que vai valer de verdade.
export TAPS_PAYOUT_MIN_FACTOR=2
```

> A fila de ciclos devidos (`TAPS_PAYOUT_MAX_OWED_CYCLES`, RN-28) não entra aqui:
> o harness roda um ciclo por vez, escolhido por ele. A variável é obrigatória
> para quem usa `CycleQueue`, que é o caminho automático de produção.

```bash
cd packages/tezos-chain && npm ci && npm run build
cd ../payout-engine   && npm ci && npm run build
cd ../../qa-harness   && npm ci

npm run doctor
npm run setup -- --stage cohort
npm run run -- --engine taps
```

### O que a corrida prova

| Cenário | O que fica demonstrado |
|---|---|
| primeira execução | o dinheiro se move e bate com o plano, mutez a mutez, contra RPC e TzKT |
| segunda execução do mesmo ciclo | zero injeções |
| morte entre injetar e confirmar | a retomada resolve o `opHash` gravado e fecha sem reenviar |
| conta não alocada | o lote **não** cai |
| membro `tz4` | recebe |
| membro de poeira | fica abaixo do corte, acumula, e é pago no ciclo seguinte |
| staker | **não** entra no lote |

---

## O que mudou nesta versão, e por quê

A primeira versão deste documento mandava rodar
`octez-signer launch socket signer --socket /run/taps/signer.sock` e falava em HTTP sobre
socket unix. **Isso não funciona, e eu só descobri porque subi o signer de verdade:**

- `launch socket signer` é **TCP com protocolo binário**, e nem aceita `--socket`.
- `launch local signer --socket` é socket unix, mas também **protocolo binário**.
- A API JSON que o motor fala existe só em `launch http signer` e `launch https signer`,
  e as duas são **TCP**. Não existe modo que sirva essa API por socket unix.

O `unix://` foi removido do cliente: aceitar o esquema só faria a instalação falhar na
primeira assinatura em vez de falhar ao subir.

### Autenticação de cliente: fechada

`--require-authentication` está **ligado** e o cliente passa. O que faltava não era o
layout de bytes — era o passo antes dele:

```
to_sign = 0x04 || 0x01 || Public_key_hash.to_bytes pkh || data
assinatura = Ed25519(BLAKE2b-256(to_sign))
```

**Assinatura Tezos nunca é sobre a mensagem: é sobre o BLAKE2b-256 dela.** O
`Signature.check` do signer hasheia `to_sign` antes de conferir, então o cliente tem que
hashear antes de assinar. Assinar o layout cru — que é o que o texto do
`signer_messages.ml` sugere sozinho — reprova com o layout perfeitamente correto. Foi
por isso que varrer tag, prefixo e formato do `pkh` nunca convergiu.

`Public_key_hash.to_bytes` é a união com tag de curva: 1 byte (tz1 = 0, tz2 = 1,
tz3 = 2, tz4 = 3) e os 20 bytes do hash.

Isso está preso por teste em dois níveis:

- `test/unit/signer.spec.ts` fixa os bytes contra um vetor capturado de um
  `octez-client` 25.1 real — mudar qualquer byte reprova;
- `npm run test:signer` sobe um `octez-signer --require-authentication` de verdade em
  docker e prova as duas direções: a chave autorizada é aceita, uma chave estranha volta
  `invalid authentication signature`.

`TAPS_SIGNER_CLIENT_AUTH_KEY` é obrigatório: sem ele o processo não sobe.

---

## Corrida de validação — 06/09/2026, autenticação ligada

Feita, e sem depender de host de ninguém. O harness saca do faucet e cria o próprio
baker; a única peça que ele não cria é o `octez-signer`, e esse sobe em docker na mesma
máquina. Ou seja: **a Parte 1 acima é opcional para Bakingnet** — ela descreve o caminho
com host separado, que é o de mainnet.

| | |
|---|---|
| baker | `tz1Yd74M2yxvENLtaskF98bnHp9NXi4apaG9` (8000 XTZ do faucet, 127 membros) |
| signer | `--require-authentication` + TLS + `--magic-bytes 0x03`, chave do baker importada |
| operação | `oogYiSyLshA7UJ5HGrBj4DwHqy7wKnvmijS7HU8Nr1ZV96rsNXz` — 125 transferências, `applied` |
| pago | 342 856 848 mutez, igual ao planejado, conferido na TzKT **e** na RPC |
| cenários | **10 de 10**, nenhum reprovado |

O signer registrou **um** pedido de assinatura no ciclo inteiro (`magic byte = 03`), e o
mesmo pedido sem o parâmetro `authentication` volta `missing authentication signature
field` — a autenticação estava mesmo ligada, não é um flag que passou batido.

Para repetir do zero, ~10 min:

```bash
cd qa-harness && npm ci
npm run setup -- --stage accounts --fund 8000     # faucet, ~3 min de prova de trabalho

# importa a chave do baker recém-criada no signer e autoriza a chave de cliente
BAKER_SK=$(python3 -c "import json;print(json.load(open('state/cohort.json'))['baker']['secretKey'])")
docker run --rm -v ~/taps-signer/data:/data --entrypoint octez-signer \
  tezos/tezos:octez-v25.1 -d /data import secret key baker "unencrypted:$BAKER_SK"
# … 1.2 (chave de cliente), 1.3 (TLS) e 1.4 (subir o daemon) acima …

npm run run -- --engine taps
```

---

## Mainnet

Não está neste documento e não está neste épico. Primeira execução que move fundos reais
é decisão do Rafael, em issue separada, com ele presente.
