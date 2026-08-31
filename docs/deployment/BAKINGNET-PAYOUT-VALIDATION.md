# Validação do payout em Bakingnet

O que falta para fechar o último critério do BRES-46: **payout completo em Bakingnet
conferido contra a cadeia, mutez a mutez**.

O código está pronto dos dois lados. O harness do BRES-44 já sabe rodar o motor de
produção (`--engine taps`), e o motor recusa subir sem signer. O que falta é a metade
que só quem tem o host pode fazer: **subir o `octez-signer` e financiar a chave**.

Rafael decidiu a opção A em 31/08. Este documento é o combinado.

---

## Parte 1 — Sua metade (host do signer)

### 1.1 O host

Máquina **separada** da que roda o harness. Pode ser uma VM pequena, um container em
outra máquina, ou o próprio tower — o que não vale é ser o mesmo processo, porque o
ponto inteiro da opção A é que a chave não vive onde o payout roda.

### 1.2 A chave de payout

É o baker de testes da Bakingnet. Se você já tem o `state/cohort.json` do harness, a
chave do baker está **lá em claro** — importe-a para o signer e **apague-a do JSON**
depois. Se ainda não existe, gere-a no host do signer e nunca a copie para fora:

```bash
octez-client --base-dir ~/.taps-signer gen keys payout
octez-client --base-dir ~/.taps-signer show address payout
# → tz1... (guarde: é o TAPS_SIGNER_PKH)
```

Financie o endereço no faucet da Bakingnet: <https://faucet.bakingnet.teztnets.com>.
Uns 8 000 ꜩ cobrem o cenário com folga.

### 1.3 A chave de cliente

Não é a chave dos fundos. Ela prova ao signer **quem está pedindo** e, sozinha, não move
nada.

```bash
octez-client --base-dir ~/.taps-client gen keys taps-client
octez-client --base-dir ~/.taps-client show address taps-client --show-secret
# → guarde a PUBLIC KEY (edpk...) para o passo 1.4
# → guarde a SECRET KEY (edsk...) para o passo 2.1
```

### 1.4 Subir o signer

Nenhuma das opções abaixo é padrão. Todas precisam estar escritas:

```bash
octez-signer --base-dir ~/.taps-signer \
  add authorized key edpk...            # a PUBLIC KEY do passo 1.3

octez-signer --base-dir ~/.taps-signer \
  launch socket signer \
  --socket /run/taps/signer.sock \
  --magic-bytes 0x03 \
  --require-authentication
```

```bash
chmod 600 /run/taps/signer.sock      # só o dono
```

O que **não** pode estar na linha de comando:

| Opção | Por quê |
|---|---|
| `--password-filename` | recria, no host do signer, exatamente o defeito que a opção A elimina |
| `--allow-list-known-keys` | expõe quais chaves o signer guarda |
| `--allow-to-prove-possession` | não é necessário para payout |
| HTTP em claro (`launch http signer`) | o corpo da requisição são os bytes que movem dinheiro |

`--magic-bytes 0x03` é o que faz o signer recusar cabeçalho de bloco e attestation. Com
ele, um host comprometido do TAPS não consegue arrancar do signer nada além de uma
operação genérica — e o destino dessa operação é conferido do lado do TAPS, contra a
lista de delegadores calculada localmente, antes de a assinatura ser pedida.

O desbloqueio da chave é **interativo, no start do daemon**. Uma ação humana por
restart, nunca uma por ciclo de payout.

### 1.5 O que me mandar

Três linhas, no comentário da issue:

```
TAPS_SIGNER_URL=unix:///run/taps/signer.sock     (ou https://... se for por TLS)
TAPS_SIGNER_PKH=tz1...                            (endereço do payout, já financiado)
TAPS_SIGNER_CLIENT_AUTH_KEY=edsk...               (a SECRET do passo 1.3, não a do payout)
```

Se o signer estiver em outra máquina que não a do harness, mande também como o harness
chega nele: `https://` com TLS, ou um túnel Tailscale expondo o socket.

**A chave de payout (`edsk` do passo 1.2) não deve ser mandada.** Se ela aparecer no
comentário, a opção A deixou de valer e a chave precisa ser rotacionada.

---

## Parte 2 — Minha metade

### 2.1 Configuração

```bash
export TEZOS_NETWORK=bakingnet
export TEZOS_RPC_URL=https://rpc.bakingnet.teztnets.com
export TZKT_API_URL=https://api.bakingnet.tzkt.io

export TAPS_SIGNER_URL=...
export TAPS_SIGNER_PKH=...
export TAPS_SIGNER_CLIENT_AUTH_KEY=...

# Teto por ciclo, em mutez. Sem ele o processo recusa subir.
export TAPS_PAYOUT_CYCLE_CAP_MUTEZ=500000000
```

### 2.2 Rodar

```bash
cd packages/tezos-chain && npm ci && npm run build
cd ../payout-engine   && npm ci && npm run build
cd ../../qa-harness   && npm ci

npm run doctor                       # confere rede, endpoints e coorte
npm run setup -- --stage cohort      # cria o coorte (borda, tz4, poeira, staker)
npm run run -- --engine taps         # paga de verdade e reconcilia contra a cadeia
```

`--engine taps` roda `@tezos-suite/payout`. Sem a flag o harness continua rodando o
oráculo (`reference`), que é o que o CI mede — trocar o padrão mudaria o portão sem
ninguém pedir.

### 2.3 O que a corrida prova

| Cenário | O que fica demonstrado |
|---|---|
| primeira execução | o dinheiro se move e bate com o plano, mutez a mutez, contra RPC e TzKT |
| segunda execução do mesmo ciclo | zero injeções — o banco recusa a segunda distribuição |
| morte entre injetar e confirmar | a retomada resolve o `opHash` gravado na cadeia e fecha sem reenviar |
| membro de conta não alocada | o lote **não** cai; o burn de alocação sai do `storage_limit` estimado |
| membro `tz4` | recebe |
| membro de poeira | fica abaixo do corte, acumula, e o replanejamento mostra que ele é pago depois |
| staker | **não** aparece no lote: o protocolo já pagou |

---

## Uma diferença que vale registrar

O cenário `idempotencia-retomada-apos-morte` do harness exigia que a retomada
**recusasse**. Isso está certo para o oráculo: o diário dele guarda a intenção *sem* o
`opHash`, então depois de uma morte ele genuinamente não sabe se pagou, e "não sei"
nunca autoriza reenviar.

O motor de produção grava o hash **antes** de injetar, então ele sabe. A RN-12 diz o que
fazer nesse caso, com essas palavras: *"a consulta on-chain diz 'aplicada'; o sistema
fecha o ciclo como pago e **não** reenvia"*.

O cenário foi ajustado para aceitar as duas saídas corretas — resolver o hash na cadeia,
ou recusar — e continua reprovando as duas erradas: injetar de novo, ou não injetar e
também não dizer nada. Exigir recusa dos dois motores transformaria a limitação do
oráculo em regra de negócio.

---

## Mainnet

Não está neste documento e não está neste épico. Primeira execução que move fundos reais
é decisão do Rafael, em issue separada, com ele presente.
