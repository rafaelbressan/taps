# Vir da versão antiga do TAPS

Se você já rodava o TAPS em Lucee, o histórico de pagamentos vem junto. A
configuração não — e a chave também não. Esta página explica o que atravessa,
o que fica para trás e por quê.

## Antes de qualquer coisa

**Não desinstale nada ainda.** A migração lê um arquivo exportado; o TAPS antigo
continua onde está até você ter conferido que o novo tem o que precisa.

## Passo 1 — Exporte o banco antigo

O TAPS antigo guarda os dados num banco H2 embutido. O formato desse arquivo só
tem leitor dentro da JVM, então em vez de pedir Java na sua máquina nova, a
migração pede um **arquivo de texto** que o próprio H2 sabe gerar.

1. Pare o Lucee:

   ```
   sudo /opt/lucee/lucee_ctl stop
   ```

2. Abra o console do H2 e conecte na URL que o TAPS antigo usa:

   ```
   jdbc:h2:/opt/lucee/tomcat/webapps/taps/database/tapsDB;MODE=MySQL
   ```

   (o caminho muda se o seu TAPS estiver em `ROOT/taps`.)

3. Rode:

   ```sql
   SCRIPT TO 'taps-export.sql'
   ```

4. Copie `taps-export.sql` para a máquina onde o TAPS novo está.

O arquivo é texto. Você pode abri-lo e ler. Guarde uma cópia: ele é o registro
do que existia antes, e vale mais que o banco binário.

## Passo 2 — Importe

No TAPS novo: **Migração → Escolher o arquivo exportado**.

A tela mostra o que entrou: quantos ciclos, quantas linhas de delegador,
quantas comissões individuais e o total já pago.

Se alguma coisa no arquivo não for entendida, **nada é importado**. O banco fica
exatamente como estava e a tela diz qual linha causou o problema. Não existe
importação pela metade.

O mesmo arquivo não pode ser importado duas vezes, nem com outro nome: o TAPS
guarda a impressão digital do conteúdo.

## Passo 3 — Confira

Compare três números com o que você sabe:

- **Total já pago.** Deve bater com a soma dos seus pagamentos.
- **Ciclos.** Deve bater com o último ciclo que você pagou.
- **Comissões individuais.** Se você tinha delegadores com taxa diferente,
  confira alguns.

Depois: **Backup → Salvar backup.** Agora sim.

## O que atravessa

| Do banco antigo | Para onde vai |
|---|---|
| `payments` — total pago por ciclo | histórico, com o valor convertido para mutez exatos |
| `delegatorsPayments` — quem recebeu quanto | histórico, por ciclo e por endereço, com o identificador da operação |
| `delegatorsFee` — comissão individual | guardada como fração exata: 5,25% vira 525/10000 |
| `bondPool` — participantes do bond pool | guardados, com a cota e a taxa administrativa |

Os valores são convertidos a partir dos **dígitos exatos** que estavam no
arquivo. A versão antiga convertia XTZ para mutez multiplicando por um milhão em
ponto flutuante, o que perde um mutez em cerca de 1% dos valores, sempre para
baixo. O histórico importado não repete esse erro — e por isso a soma pode
diferir da que o sistema antigo mostrava, para mais, em alguns mutez.

## O que fica para trás, e por quê

| Do banco antigo | Por quê |
|---|---|
| `user_name`, `pass_hash`, `hash_salt` | não há mais página na internet, então não há login |
| `phrase`, `app_phrase`, `wallet_hash`, `wallet_salt` | é a carteira cifrada com sal literal e sem autenticação. Trazer isso seria trazer um modelo de custódia quebrado para um produto que decidiu não guardar chave nenhuma |
| `application_port`, `client_path`, `base_dir`, `node_alias` | configuração de uma instalação Lucee que não existe mais |
| `gas_limit`, `storage_limit`, `transaction_fee`, `num_blocks_wait` | são números da rede, e agora são lidos da rede a cada ciclo. Foi ter esses valores fixos no banco que deixou a versão antiga presa a 2019 |
| `default_fee`, `mode`, `provider`, `block_explorer` | você reconfigura na tela, uma vez. São quatro campos |

## A carteira nativa do TAPS antigo

Se você usava a "Native Wallet" para pagar, ela **não vem junto**, e isso é
deliberado: o TAPS novo não guarda chave de pagamento em lugar nenhum.

Você tem duas escolhas:

1. **Recomendada.** Crie uma chave nova dentro do `octez-signer`, mande para ela
   o saldo que estava na carteira antiga, e passe a pagar de lá.
2. Importe a chave antiga para dentro do `octez-signer`, com
   `octez-signer import secret key payout unencrypted:edsk…`, e apague-a de
   todo o resto.

Nos dois casos: a frase de recuperação da carteira antiga estava cifrada com um
sal fixo e sem verificação de integridade. Trate-a como comprometida se o
computador antigo já foi acessado por alguém. A escolha 1 resolve isso; a 2 não.

## E os ciclos que ficaram devendo?

O histórico importado diz o que **foi pago**. Ele não é usado para decidir o que
**vai ser pago**: essa decisão vem da cadeia e do banco novo.

Na Configuração, o campo **Primeiro ciclo desta instalação** é o que evita que o
TAPS novo tente pagar um ciclo antigo de novo. Ponha ali o **ciclo seguinte ao
último que você pagou**.

Se você deixar um número menor, o TAPS vai encontrar vários ciclos devidos e
**parar, perguntando**, em vez de pagar. Isso é o comportamento certo, e a tela
de início explica.

## Quando desinstalar o antigo

Depois de:

- [ ] importar e conferir os três números;
- [ ] salvar um backup do TAPS novo;
- [ ] rodar um ciclo inteiro no novo e conferir na Trilha;
- [ ] guardar `taps-export.sql` em lugar seguro.

Aí sim.
