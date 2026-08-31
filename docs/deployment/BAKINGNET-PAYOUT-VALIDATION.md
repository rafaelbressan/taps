# Validação do payout em Bakingnet

O que falta para fechar o último critério do BRES-46: **payout completo em Bakingnet
conferido contra a cadeia, mutez a mutez**.

O harness do BRES-44 já sabe rodar o motor de produção (`--engine taps`), e o motor
recusa subir sem signer. Falta a metade que só quem tem o host pode fazer: **subir o
`octez-signer` e financiar a chave**.

> **Os três valores não existem em lugar nenhum ainda. Você os cria.** Não há onde
> procurá-los: `TAPS_SIGNER_URL` é o endereço que você escolhe para o daemon,
> `TAPS_SIGNER_PKH` é o endereço de uma chave que você gera, e o `octez-signer` é um
> binário que você sobe. Os comandos abaixo produzem os três.

**Tudo aqui foi executado de verdade contra `octez-signer` 25.1 em 31/08**, e a primeira
versão deste documento estava errada — ver "O que mudou" no fim.

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

### 1.2 O certificado TLS — vira o `TAPS_SIGNER_URL`

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

### 1.3 Subir o daemon

```bash
docker run -d --name taps-signer -p 6732:6732 \
  -v ~/taps-signer/data:/data \
  -v ~/taps-signer/tls.crt:/tls.crt:ro \
  -v ~/taps-signer/tls.key:/tls.key:ro \
  --entrypoint octez-signer tezos/tezos:latest \
  -d /data launch https signer /tls.crt /tls.key \
  --address 0.0.0.0 --port 6732 --magic-bytes 0x03

docker logs taps-signer     # deve dizer "accepting HTTPS requests on port 6732"
```

`--magic-bytes 0x03` é o que faz o signer recusar cabeçalho de bloco e attestation: com
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

### 1.4 O que me mandar

```
TAPS_SIGNER_URL=https://<host-ou-ip>:6732
TAPS_SIGNER_PKH=tz1...            (o do passo 1.1, já financiado)
```

Mais o **conteúdo do `tls.crt`** (é público — é o certificado, não a chave). Sem ele o
Node recusa o certificado próprio.

**A chave de payout (o `edsk` do baker) não vem no comentário.** Se vier, a opção A
deixou de valer e a chave precisa ser rotacionada.

---

## Parte 2 — Minha metade

```bash
export TEZOS_NETWORK=bakingnet
export TEZOS_RPC_URL=https://rpc.bakingnet.teztnets.com
export TZKT_API_URL=https://api.bakingnet.tzkt.io

export TAPS_SIGNER_URL=https://<host>:6732
export TAPS_SIGNER_PKH=tz1...
export NODE_EXTRA_CA_CERTS=/caminho/para/tls.crt

# Teto por ciclo, em mutez. Sem ele o processo recusa subir.
export TAPS_PAYOUT_CYCLE_CAP_MUTEZ=500000000
```

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

### Autenticação de cliente: pendente

A decisão de custódia pede `--require-authentication`. **O cliente ainda não passa nessa
checagem** — testado contra o signer real, toda variante volta
`invalid authentication signature`, enquanto o mesmo pedido sem autenticação é aceito.
Ou seja: URL, caminho, corpo e derivação de chave estão certos; só os bytes assinados
estão errados.

O layout que o Octez confere está em `src/lib_signer_services/signer_messages.ml`
(`octez-v25.1`):

```
to_sign = 0x04 || tag || Signature.Public_key_hash.to_bytes pkh || data     (tag = 1)
```

Reproduzir isso ainda reprova, então `Public_key_hash.to_bytes` não é nem os 20 bytes
crus nem os 21 da união com tag — os dois foram tentados.

**Consequência prática:** a validação em Bakingnet roda **sem**
`--require-authentication`. O que continua valendo é TLS, `--magic-bytes 0x03`, a
conferência de destino contra a lista de delegadores e o teto por ciclo. Fechar a
autenticação é item próprio, e é **pré-requisito de mainnet**, não de Bakingnet.

---

## Mainnet

Não está neste documento e não está neste épico. Primeira execução que move fundos reais
é decisão do Rafael, em issue separada, com ele presente — e depois da autenticação
resolvida.
