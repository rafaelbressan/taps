# O `octez-signer`, para quem opera um baker

O TAPS não guarda a chave que paga. Ela fica no `octez-signer`, um programa
separado que roda em outro computador e que você controla. O TAPS manda os
bytes da operação e recebe a assinatura de volta; a chave nunca sai dali.

Isso custa uma coisa, e é honesto dizer logo: **você passa a operar um daemon a
mais**. Ele precisa ser instalado, atualizado, olhado de vez em quando e
**destravado à mão depois de todo reinício**. Esta página é sobre isso.

Os comandos abaixo foram executados de verdade contra o `octez-signer` 25.1.

---

## Por que não dá para automatizar o destravamento

O `octez-signer` aceita uma opção chamada `--password-filename`, que lê a senha
da chave de um arquivo e sobe sozinho. **Não use.** Com ela, a senha fica no
mesmo disco que a chave, e quem entrar naquele computador leva as duas — o que
apaga a única razão de a chave estar num computador separado.

A consequência é real e você vai senti-la: **depois de um reinício, o signer
fica parado até alguém digitar a senha.** Enquanto isso o TAPS não paga, avisa
na tela e escreve na Trilha. Uma ação humana por reinício, não uma por ciclo.

Se isso for inaceitável para você, a conversa é sobre trocar o signer por um
Ledger, não sobre `--password-filename`.

---

## Instalar

### Onde

Num computador diferente do TAPS. Uma máquina virtual pequena, um Raspberry Pi,
um servidor caseiro — qualquer coisa que:

- fique ligada quando você quiser pagar;
- só aceite conexão da máquina do TAPS na porta 6732;
- não seja a máquina onde você lê e-mail.

Se for a mesma máquina do TAPS, o arranjo continua funcionando e continua sendo
pior. Anote que você aceitou esse risco.

### Com Docker (mais simples)

```bash
docker pull tezos/tezos:latest
mkdir -p ~/taps-signer/data ~/taps-signer/client
```

### Sem Docker

Baixe o binário `octez-signer` do release oficial do Octez e coloque em
`/usr/local/bin/`. Os comandos abaixo ficam iguais, sem o `docker run … --entrypoint octez-signer tezos/tezos:latest`.

---

## Passo 1 — Crie a chave que paga

Ela nasce dentro do host do signer e **nunca sai dali**.

```bash
docker run --rm -v ~/taps-signer/data:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data gen keys payout --encrypted

docker run --rm -v ~/taps-signer/data:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data show address payout
```

`--encrypted` faz o `octez-signer` pedir uma senha. Escolha uma senha longa,
guarde-a onde você guarda as coisas importantes, e saiba que **é ela que você
vai digitar depois de todo reinício**.

A saída do segundo comando traz:

```
Hash: tz1P3fJFGgbGnBNeZeSfHz5NEFzFe2aRqZBv     ← anote: é o "endereço da chave de pagamento"
```

Esse endereço precisa ter saldo: é dele que os pagamentos saem.

## Passo 2 — Crie a credencial de cliente

O signer vai rodar recusando qualquer pedido que não venha assinado por uma
chave que ele conhece. Essa chave diz *quem está pedindo* — e vale ser exato
sobre o que isso significa: ela **não guarda os fundos**, mas **é capacidade de
gasto**. Quem a tiver consegue pedir ao seu signer que assine uma
transferência. Trate-a como uma chave, não como um crachá.

```bash
docker run --rm -v ~/taps-signer/client:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data gen keys client

cat ~/taps-signer/client/public_keys   # o edpk… — fica no signer
cat ~/taps-signer/client/secret_keys   # o edsk… — vai para a máquina do TAPS
```

Autorize a pública:

```bash
docker run --rm -v ~/taps-signer/data:/data --entrypoint octez-signer \
  tezos/tezos:latest -d /data add authorized key <edpk-do-cliente>
```

O arquivo `secret_keys` é o que você vai escolher na tela de Configuração do
TAPS. Leve-o para a máquina do TAPS por um caminho que você confia — pen drive,
`scp`, o que for. Depois de importado, apague o arquivo da máquina do TAPS: o
cofre do sistema operacional passa a ser a cópia.

## Passo 3 — Certificado TLS

O signer só serve esta API por TCP, e HTTP em claro está proibido: o corpo da
requisição **são os bytes que movem dinheiro**, e quem estiver no caminho pode
trocá-los.

```bash
cd ~/taps-signer
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout tls.key -out tls.crt \
  -subj "/CN=taps-signer" \
  -addext "subjectAltName=IP:192.168.1.20,DNS:taps-signer"
```

Troque `192.168.1.20` pelo endereço que a máquina do TAPS vai usar para chegar
no signer. Anote a data: **o certificado vence em um ano**, e quando vencer o
TAPS para de conseguir assinar. Ponha um lembrete.

## Passo 4 — Suba o daemon

```bash
docker run -it --name taps-signer -p 6732:6732 \
  -v ~/taps-signer/data:/data \
  -v ~/taps-signer/tls.crt:/tls.crt:ro \
  -v ~/taps-signer/tls.key:/tls.key:ro \
  --entrypoint octez-signer tezos/tezos:latest \
  -d /data --require-authentication launch https signer /tls.crt /tls.key \
  --address 0.0.0.0 --port 6732 --magic-bytes 0x03
```

Repare no `-it`: o daemon vai **pedir a senha da chave no terminal**. Digite.
Depois disso ele imprime `accepting HTTPS requests on port 6732` e fica no ar.

As duas opções que não podem faltar:

| Opção | O que ela impede |
|---|---|
| `--require-authentication` | que qualquer processo com acesso à porta peça assinatura |
| `--magic-bytes 0x03` | que o signer assine cabeçalho de bloco ou attestation — com ela, o máximo que sai é uma operação comum |

E as que **não** podem entrar:

| Opção | Por quê |
|---|---|
| `--password-filename` | põe a senha no mesmo disco que a chave |
| `--allow-list-known-keys` | conta para quem perguntar quais chaves o signer guarda |
| `--allow-to-prove-possession` | não é preciso para pagar |
| `launch http signer` | corpo em claro |

---

## Destravar depois de um reinício

**Toda vez que o computador do signer reiniciar**, alguém precisa digitar a
senha. Não há como contornar isso sem desfazer a proteção.

O jeito prático de conviver com isso é deixar o daemon numa sessão `tmux`, para
que você possa entrar por SSH, digitar a senha e sair sem derrubá-lo:

```bash
tmux new -s signer
docker start -ai taps-signer     # pede a senha; digite
# Ctrl-B, depois D — sai do tmux sem parar o daemon
```

Para voltar depois: `tmux attach -t signer`.

**Como saber que ele está travado:** o TAPS mostra "não consegui falar com o
octez-signer" na tela de início e escreve `scheduler.failed` na Trilha, com a
hora. Nenhum pagamento acontece, nada fica pela metade, e o TAPS volta a tentar
sozinho assim que o signer responder.

---

## Olhar de vez em quando

Uma vez por semana, ou depois de qualquer coisa estranha:

```bash
# está no ar?
docker ps --filter name=taps-signer

# o que ele fez?
docker logs --tail 50 taps-signer

# o saldo da chave que paga ainda cobre o próximo ciclo?
#   (veja o endereço no explorador de blocos que você usa)
```

Um sinal de alerta que vale conhecer: pedidos de assinatura que você não
reconhece nos logs. O signer registra cada um. Se aparecer um sem que o TAPS
tenha rodado, alguém está com a credencial de cliente.

---

## Atualizar

O signer é um daemon de segurança: vale atualizar quando sair versão nova do
Octez.

```bash
docker pull tezos/tezos:latest
docker stop taps-signer && docker rm taps-signer
# suba de novo com o comando do Passo 4 — a chave está no volume, não na imagem
```

Depois de subir, **digite a senha de novo** e confira o log.

Sem Docker: troque o binário e reinicie o daemon.

Antes de qualquer atualização, faça um backup do diretório
`~/taps-signer/data`: é onde a chave cifrada mora. Guarde-o num lugar
diferente de onde você guarda a senha.

---

## Quando o TAPS reclamar

| O que a tela diz | O que costuma ser |
|---|---|
| "não consegui falar com o octez-signer" | daemon parado, ou travado esperando a senha depois de um reinício |
| erro de certificado | o TLS venceu, ou o endereço que o TAPS usa não está no `subjectAltName` |
| "o signer recusou o pedido" | a credencial de cliente não foi autorizada, ou foi trocada |
| "não há credencial de cliente guardada nesta máquina" | o cofre do sistema não tem a chave — reimporte pela Configuração |

---

## O que este arranjo **não** protege

Vale escrever, porque o contrário seria falso conforto.

A decisão de custódia elimina o **roubo da chave de pagamento**. Ela não
elimina o **uso indevido** dela: quem tiver a credencial de cliente e alcançar
a porta do signer consegue pedir assinatura de transferência.

Vale ser franco sobre o que **não** protege contra isso. O TAPS confere o
destino de cada transferência contra a lista de delegadores que ele mesmo
calculou, tem um teto por ciclo que você escolheu, e não paga o mesmo ciclo
duas vezes. As três coisas rodam **dentro** da máquina do TAPS, e por isso não
alcançam quem fale direto com o signer. Elas protegem contra o TAPS errar, não
contra alguém no lugar dele.

O que protege de verdade, e por isso não é opcional:

- **`--require-authentication`** — sem a credencial, ninguém pede nada.
- **`--magic-bytes 0x03`** — mesmo com tudo comprometido, o signer não assina
  cabeçalho de bloco nem attestation, então o seu baker não é penalizado por
  dupla assinatura. É o pior caso fechado.
- **Rede** — só a máquina do TAPS deveria alcançar a porta 6732.
- **A credencial no cofre do sistema operacional**, do lado do TAPS, sem
  atravessar para a janela do aplicativo e sem entrar no backup.

E é por isso que o arquivo com a credencial deve ser apagado da máquina do TAPS
depois de importado, e que o TAPS recusa um arquivo com mais de uma chave: o
`secret_keys` do signer tem várias, e uma delas é a de pagamento.
