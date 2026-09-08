# Instalar o TAPS

Este guia é para um **baker**, não para um desenvolvedor. Você não vai precisar
compilar nada, editar arquivo de configuração nem abrir terminal para usar o
TAPS — só para o `octez-signer`, que é um programa separado e tem
[runbook próprio](OCTEZ-SIGNER.md).

Leia a página inteira antes de começar. São cerca de 40 minutos, quase todos
esperando o signer.

## O que o TAPS é, em três frases

O TAPS distribui as recompensas do seu baker aos seus delegadores. Ele roda
**na sua máquina**: não tem servidor, não tem senha, não tem página na internet
e não abre porta nenhuma. A chave que paga **não fica nele** — ela fica no
`octez-signer`, num computador que você controla, e o TAPS só pede assinatura.

## O que você precisa antes

| | |
|---|---|
| Um computador com Windows 10/11 ou Linux | é onde o TAPS roda |
| Um segundo computador, ou uma máquina virtual, para o `octez-signer` | é onde a chave fica |
| O endereço do seu baker (`tz1…`) | |
| Um nó Tezos que você possa consultar | o seu, de preferência |

**Por que dois computadores?** Porque a única proteção que vale contra a máquina
do TAPS ser invadida é a chave não estar nela. Se ela estiver, quem entrar na
máquina leva os fundos. Rodar os dois no mesmo computador é possível e é pior;
se for o seu caso, escreva isso num papel e saiba que você aceitou esse risco.

## Passo 1 — Instale o `octez-signer` primeiro

O TAPS **não abre para operar** sem o signer configurado. Isso é de propósito:
um programa de pagamento que sobe sem saber quem assina acaba assinando de
outro jeito.

Siga o [runbook do `octez-signer`](OCTEZ-SIGNER.md) até o fim e volte com três
coisas anotadas:

1. O endereço `https://` do signer (por exemplo `https://192.168.1.20:6732`).
2. O endereço `tz1…` da chave de pagamento, como o signer a conhece.
3. O **arquivo** da credencial de cliente que você autorizou no signer.

## Passo 2 — Instale o TAPS

### Onde baixar

Ainda **não existe release publicada**. Os instaladores saem da integração
contínua do projeto:

1. Abra <https://github.com/rafaelbressan/taps/actions/workflows/desktop.yml>.
2. Clique na execução verde mais recente do ramo `master`.
3. Em **Artifacts**, baixe `taps-ubuntu-22.04` (Linux) ou `taps-windows-latest`
   (Windows). Os dois vêm em `.zip`; descompacte antes de instalar.

Nenhum dos instaladores é assinado. O Windows mostra o aviso do SmartScreen na
primeira execução — é esperado, e some quando houver certificado.

### Windows

Dentro do `.zip`, o instalador é `TAPS_0.1.0_x64-setup.exe`. Execute e siga o
assistente. Ele instala para o seu usuário, em `%LOCALAPPDATA%\TAPS`, e não pede
privilégio de administrador.

### Linux (Debian, Ubuntu)

O pacote está em `deb/TAPS_0.1.0_amd64.deb` — repare no nome em **maiúsculas**.
Instale com:

```
sudo apt install ./TAPS_0.1.0_amd64.deb
```

O `apt` resolve sozinho as duas dependências (`libwebkit2gtk-4.1-0` e
`libgtk-3-0`). Para remover depois: `sudo apt remove taps`.

No fim ele costuma imprimir um aviso assim:

```
N: Download is performed unsandboxed as root as file '/home/você/Downloads/…'
   couldn't be accessed by user '_apt'. - pkgAcquire::Run (13: Permission denied)
```

**Isso não é erro e a instalação deu certo.** O `apt` tenta ler o arquivo como
o usuário `_apt`, que não entra na sua pasta pessoal porque ela é sua e de mais
ninguém; então ele lê como root e avisa. Se aparecer, confira com
`dpkg -l taps` — uma linha começando por `ii` quer dizer instalado.

Precisa de Debian 12 ou Ubuntu 22.04 para cima — versões mais antigas trazem o
webkit 4.0 e o pacote não instala.

### Linux (outras distribuições)

O AppImage está em `appimage/TAPS_0.1.0_amd64.AppImage`. Dê permissão de
execução e abra — não instala nada:

```
chmod +x TAPS_0.1.0_amd64.AppImage
./TAPS_0.1.0_amd64.AppImage
```

No Linux o TAPS guarda a credencial do signer no **cofre de credenciais da sua
sessão gráfica** (gnome-keyring ou kwallet). Se ele não estiver rodando, o TAPS
avisa e não deixa você seguir — não é um erro seu.

## Passo 3 — Configure

Abra o TAPS. A tela de início vai dizer, em português, o que ainda falta. Vá em
**Configuração** e preencha:

| Campo | O que é |
|---|---|
| Endereço do baker | o `tz1…` cujas recompensas serão distribuídas |
| Rede | comece por `shadownet`. `mainnet` move dinheiro de verdade |
| Endereço do nó (RPC) | quem estima e injeta a operação |
| Endereço da TzKT | de onde vêm o ciclo e a divisão das recompensas |
| Endereço do octez-signer | tem que começar com `https://` |
| Endereço da chave de pagamento | o `tz1…` de onde o dinheiro sai |
| Comissão | uma fração, não um decimal: 5% é `5` sobre `100`; 5,25% é `525` sobre `10000` |
| Fator de corte K | quanto o delegador precisa ter a receber para valer a transferência. `3` sobre `1` é um ponto de partida razoável |
| Teto por ciclo | acima disso o TAPS recusa e chama você |
| Máximo de ciclos devidos | acima disso a fila para e pergunta |
| Primeiro ciclo desta instalação | de onde o TAPS começa a olhar para trás |

**Nenhum campo tem valor de fábrica**, e isso é deliberado. Um teto por ciclo
que ninguém escolheu não é um teto.

Ainda em **Configuração**, clique em **Escolher o arquivo da credencial** e
aponte para o arquivo do passo 1. A chave vai do disco direto para o cofre do
sistema — ela não passa pela tela e não é digitada.

Três coisas para conferir aí:

- O arquivo precisa ter **uma chave só**. O `secret_keys` do próprio signer tem
  várias, e uma delas é a de pagamento; o TAPS recusa esse arquivo em vez de
  escolher por você.
- Depois de importar, a tela mostra a **chave pública** (`edpk…`). Compare com
  a que você autorizou no signer. Se forem diferentes, você importou a errada.
- **Apague o arquivo** da máquina do TAPS. O cofre do sistema passa a ser a
  cópia.

Essa credencial não guarda os seus fundos, mas quem a tiver consegue pedir ao
seu signer que assine uma transferência. Trate-a como uma chave.

### O que você **não** vai encontrar na configuração, e por quê

- **Usuário e senha.** Não há página na internet, então não há a quem
  autenticar. A versão antiga tinha login porque era um site; esta não é.
- **Limite de gas, limite de storage, taxa fixa.** São números da rede, e o
  TAPS os lê da rede a cada ciclo. Foi ter esses números escritos no código que
  deixou a versão antiga parada em 2019.
- **A chave que paga.** Nunca esteve aqui.

## Passo 4 — Confira em rede de teste

Deixe a rede em `shadownet` e clique em **Rodar agora**, na tela de início. O
TAPS vai:

1. Ver qual é o ciclo atual.
2. Ver quais ciclos você deve.
3. Se não houver nada a pagar, dizer isso e parar.

Vá em **Trilha**. Cada coisa que o TAPS fez tem uma linha, com a hora, quem
pediu e o que aconteceu. Se a trilha estiver vazia, nada rodou.

## Passo 5 — Faça o primeiro backup

Vá em **Backup** e clique em **Salvar backup**. Guarde o arquivo **fora deste
computador**. Faça isso antes de qualquer coisa em mainnet.

O [guia de backup e restauração](BACKUP-E-RESTAURACAO.md) explica o resto,
inclusive como voltar atrás.

## Passo 6 — Mainnet

Trocar para `mainnet` é uma decisão sua, e não tem volta para o dinheiro que
sair. Antes:

- [ ] Rodou pelo menos um ciclo inteiro em rede de teste e conferiu na Trilha.
- [ ] O `octez-signer` está com `--require-authentication` e `--magic-bytes 0x03`.
- [ ] O teto por ciclo está num valor que você reconheceria como errado se
      fosse ultrapassado.
- [ ] Tem backup guardado fora da máquina.
- [ ] Sabe destravar o signer depois de um reinício (o runbook explica).

## Já usava o TAPS antigo?

O histórico de pagamentos vem junto. Veja
[migração da versão antiga](MIGRACAO-DA-VERSAO-ANTIGA.md).

## Deixar rodando

O TAPS precisa estar **aberto** para pagar. Ele acorda sozinho a cada dez
minutos e verifica se há ciclo a pagar; com a janela fechada, nada acontece.

Um ciclo Tezos leva cerca de um dia, então fechar o TAPS por algumas horas não
perde nada — o ciclo continua devido e é pago na próxima vez que ele abrir. O
que **não** é seguro é ficar semanas fechado: quando você reabrir, a fila vai
encontrar vários ciclos devidos e vai **parar e perguntar**, em vez de pagar
tudo de uma vez. Isso é o comportamento certo, e a tela de início explica o que
fazer.

## Quando alguma coisa der errado

O TAPS foi escrito para parar e falar, não para chutar. Se um número não pôde
ser lido, ele aparece como **não lido** — nunca como zero. Se o signer não
responde, ele diz isso e espera, dobrando o tempo entre as tentativas, e a
Trilha registra cada falha.

O que **nunca** acontece: pagar duas vezes o mesmo ciclo. O identificador da
operação é gravado no banco **antes** de a operação existir, e uma segunda
tentativa lê o estado da primeira na cadeia antes de fazer qualquer coisa.
