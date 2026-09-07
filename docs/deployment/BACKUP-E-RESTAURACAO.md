# Backup e restauração

Sem terminal, sem comando, sem papel.

Vale comparar com a instrução da versão antiga, que era literalmente esta:

> 1. (Always!) Write down in a piece of paper your Taps Native Wallet mnemonic
>    words and passphrase.
> 2. `sudo git fetch --all`
> 3. `sudo git reset --hard origin/master`

Um procedimento de backup que começa num papel e termina num comando
destrutivo não é um procedimento de backup. Este é diferente.

## Salvar uma cópia

**Backup → Salvar backup.** Escolha onde salvar. Pronto.

Três coisas que valem saber:

- **Pode fazer com o TAPS aberto**, inclusive no meio de um ciclo. A cópia sai
  inteira, do estado daquele instante. Copiar o arquivo do banco por fora, com
  o TAPS aberto, pode capturar um arquivo pela metade — não faça isso.
- **Nada é sobrescrito.** Se já existir um arquivo com aquele nome, o TAPS
  recusa e pede outro.
- **Guarde fora deste computador.** Um backup no mesmo disco não sobrevive ao
  que costuma acontecer com discos.

Faça um antes de qualquer mudança grande: trocar para mainnet, atualizar o
TAPS, mexer na comissão.

## O que está no backup

Tudo que o TAPS sabe sobre dinheiro:

- cada ciclo distribuído, com o valor, a comissão e o resto;
- cada delegador, com o que recebeu, o que ficou devendo e por quê;
- cada operação enviada, com o identificador e o que a cadeia respondeu;
- o histórico importado da versão antiga, se você importou;
- a sua configuração;
- a trilha de auditoria inteira.

## O que **não** está, e por quê

**A credencial de cliente do `octez-signer`.** Ela fica no cofre de credenciais
do sistema operacional, não no banco. Restaurar noutra máquina exige cadastrá-la
de novo, pela Configuração.

Isso é de propósito. Um backup que carrega credencial é uma credencial a mais
circulando em pen drive, em e-mail e em serviço de nuvem — e o backup é
justamente o arquivo que mais viaja.

**A chave que paga.** Ela nunca esteve no TAPS. Está no host do
`octez-signer`, e o backup dela é o backup daquele diretório, descrito no
[runbook do signer](OCTEZ-SIGNER.md).

## Restaurar

**Backup → Restaurar backup.** Escolha o arquivo.

Antes de trocar qualquer coisa, o TAPS **confere o arquivo** e recusa com o
motivo se ele:

- não for um banco de dados;
- for um banco, mas não do TAPS;
- estiver corrompido;
- tiver sido escrito por uma versão mais nova do TAPS que a instalada.

Nos quatro casos o banco atual fica exatamente como estava.

Passando na conferência, o TAPS **para e pergunta**, na própria tela. Escolher
o arquivo no diálogo não troca nada. O que ele mostra antes da pergunta é a
comparação entre os dois bancos:

|                     | Este backup | Seu banco agora |
| ------------------- | ----------: | --------------: |
| Ciclos              |           4 |              12 |
| Ciclo mais recente  |         808 |             824 |

É essa comparação que revela o arquivo errado **antes** da troca. Se o banco de
agora tem ciclos que o backup não tem, o TAPS diz quantos são.

Só depois de você clicar em **Restaurar**:

1. O banco de agora é **renomeado ao lado**, com data e hora no nome. Ele não é
   apagado.
2. O backup toma o lugar dele.
3. O TAPS reabre o banco restaurado.

Se você escolheu o arquivo errado, o banco anterior está ali, com o nome
terminado em `.substituido-…`. Renomeie de volta e reabra o TAPS.

## O que você perde ao restaurar

Tudo que aconteceu **depois** de o backup ter sido tirado. Se um ciclo foi pago
nesse meio-tempo, o banco restaurado não sabe disso.

Isso importa mais do que parece: o TAPS decide se já pagou um ciclo olhando o
próprio banco. Um banco restaurado que não conhece o ciclo 812 vai planejar o
812 de novo.

O que impede o pagamento duplo, mesmo aí, é a cadeia: antes de enviar qualquer
coisa, o motor confere na rede se aquela operação já existe. Mas **confira você
também**: depois de restaurar, abra Ciclos e compare com o explorador de blocos
antes de deixar o agendador rodar.

## Com que frequência

- Depois de configurar pela primeira vez.
- Antes de trocar para mainnet.
- Antes de atualizar o TAPS.
- Uma vez por mês, se você estiver pagando em mainnet.

Um backup por ciclo é exagero: o banco é pequeno e o que ele guarda também está
na cadeia. O que o backup salva de verdade é a sua configuração e a trilha —
que **não** estão na cadeia.

## Teste a restauração, uma vez

Um backup que nunca foi restaurado não é um backup: é um arquivo.

Faça isto uma vez, com calma, fora de mainnet:

1. Salve um backup.
2. Anote quantos ciclos aparecem na tela de Ciclos.
3. Restaure aquele mesmo backup.
4. Confira que o número é o mesmo e que a Trilha continua lá.

Leva cinco minutos e é a única forma de saber que o caminho funciona antes de
você precisar dele.
