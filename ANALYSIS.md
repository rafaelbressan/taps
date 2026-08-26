# TAPS — análise técnica e plano de evolução

Análise feita em 2026-08-26 sobre o commit `9116d30` ("chore: Remove legacy ColdFusion and Java files", 26/11/2025), branch `main`.

## Sumário

O TAPS foi migrado de ColdFusion/Lucee para um backend NestJS 10 + TypeScript + Prisma + Taquito. São ~13.500 linhas em `src/` e ~4.200 em `test/`, distribuídas em módulos bem nomeados (auth, blockchain, rewards, payments, wallet, bond-pool, jobs, monitoring), com Swagger, Bull, Winston, Sentry, Helmet, Throttler e um pipeline de CI/CD completo para AWS ECS.

**A estrutura é boa. O código não funciona.**

Essa é a conclusão central e ela não é uma opinião de estilo. Verificações objetivas:

1. **O projeto não compila.** `src/modules/blockchain/services/tzkt-client.service.ts` declara seis campos duplicados na interface `BakerRewards`, gerando 12 erros `TS2300`. Confirmado rodando `tsc` sobre o arquivo real. Há mais erros de tipo além desses (seção 1.2).
2. **Não existem migrations.** `prisma/migrations/` contém apenas um `.gitkeep`. O `prisma migrate deploy` do CI e do runbook de produção não cria tabela nenhuma.
3. **Módulos centrais não estão registrados.** `AppModule` importa apenas Config, Database, Auth, Settings, Payments e Jobs. `MonitoringModule` — que contém as rotas de métricas, health e o Sentry — nunca é carregado.
4. **O cálculo de recompensa retorna zero para todo mundo.** O cliente TzKT lê campos que a API não retorna mais, e todo acesso usa `|| 0`. Detalhado em 1.3.

O sistema mexe com dinheiro real de terceiros: ele distribui recompensas de um baker para seus delegadores. As seções 2 e 3 tratam os problemas nessa chave — não como bugs, mas como risco financeiro.

Nota importante: os documentos em `migration-docs/` descrevem a dívida técnica do **código ColdFusion antigo**. Eles são bons, mas descrevem um sistema que não existe mais. Esta análise cobre o código TypeScript atual, que não estava documentado.

---

## 1. O que impede o sistema de rodar

### 1.1 O build quebra

```
$ tsc --noEmit src/modules/blockchain/services/tzkt-client.service.ts
real.ts(22,3): error TS2300: Duplicate identifier 'ownBlockFees'.
real.ts(25,3): error TS2300: Duplicate identifier 'extraBlockFees'.
real.ts(28,3): error TS2300: Duplicate identifier 'missedOwnBlockFees'.
... (12 erros)
```

A interface `BakerRewards` declara `ownBlockFees`, `extraBlockFees`, `missedOwnBlockFees`, `missedExtraBlockFees`, `uncoveredOwnBlockFees` e `uncoveredExtraBlockFees` duas vezes cada.

Como o job `build` do CI roda `npm run build`, **o pipeline está vermelho no `main`**. E como ele depende de `needs: [lint, test]`, nenhum deploy jamais aconteceu por esse caminho.

### 1.2 Outros erros de tipo confirmados por leitura

`src/modules/payments/controllers/payments.controller.ts` acessa campos que não existem:

- `p.grossRewards`, `p.netRewards`, `p.bakerFee`, `p.delegatorsCount`, `p.transactionId`, `p.errorMessage` — `PaymentEntity` tem apenas `id, bakerId, cycle, date, result, total, transactionHash, createdAt, updatedAt`.
- `result.delegatorDistribution.cycle`, `.delegatorsPaid`, `.totalDistributed`, `.transactionHashes` — `FullDistributionResult.delegatorDistribution` é declarado como `{success, totalDelegators, totalAmount, transactionHash?}`. Nenhum dos quatro nomes usados existe.

O `tsconfig.json` não liga `strict`, só `strictNullChecks` e `noImplicitAny`. Mesmo assim esses são erros `TS2339`.

O padrão por trás disso: **as camadas foram escritas contra interfaces imaginadas, não contra as interfaces vizinhas reais.** Ligar `strict: true` e fazer o build passar é o primeiro trabalho, e ele vai revelar mais.

### 1.3 Nenhum delegador recebe nada

`TzKTClientService.getRewardSplit()` chama `/v1/rewards/split/{baker}/{cycle}` e monta o total assim:

```ts
const totalRewards = new Decimal(data.ownBlockRewards || 0)
  .plus(data.extraBlockRewards || 0)
  .plus(data.endorsementRewards || 0)
  ...
```

E lê a recompensa individual como `delegator.reward || 0`.

Dois problemas somados:

- Esses nomes de campo são do formato pré-Tenderbake da TzKT. Com Tenderbake e depois com Adaptive Issuance, o `rewards/split` passou a expor recompensas separadas por origem (delegada vs. stakeada) com outros nomes. Os antigos não vêm mais.
- O array `delegators` do `rewards/split` traz **saldos**, não um campo `reward` pronto. A divisão proporcional é responsabilidade do cliente.

Como todo acesso tem `|| 0`, **nada disso levanta erro**. `totalRewards` vira 0, cada `delegator.reward` vira 0, o `RewardCalculatorService` calcula 0 para todos, o `buildBatchTransaction` descarta os valores zerados e o batch fica vazio — aí `sendBatchTransaction` lança `"Batch cannot be empty"`. O operador vê uma falha genérica, sem nenhuma pista de que a causa foi um contrato de API quebrado.

Agravante: `validateCalculation()` não pega isso, porque a checagem que ela faz é vazia por construção:

```ts
const distributed = result.totalDelegatorPayments.plus(result.bakerShare);
if (distributed.greaterThan(result.totalRewards.plus(0.000001))) { ... }
```

Como `bakerShare = totalRewards - totalDelegatorPayments`, `distributed` é **identicamente igual** a `totalRewards`. A condição nunca pode ser verdadeira. É um teste que sempre passa.

### 1.4 Sem migrations, sem banco

`prisma/migrations/` só tem `.gitkeep`. O `schema.prisma` está escrito, mas nenhuma migration foi gerada. Consequências:

- O passo `npx prisma migrate deploy` do CI roda com sucesso e não cria nada.
- Os testes de banco (`test/database/repositories.e2e.spec.ts`) rodam contra um schema vazio.
- O `DEPLOYMENT_RUNBOOK.md` descreve um deploy que não pode funcionar.

### 1.5 Módulos órfãos

`AppModule` não importa `MonitoringModule`. Ou seja: `MetricsController`, `HealthController` (o do módulo de monitoring), `SentryService` e `MetricsService` **nunca são instanciados**. As dependências `@sentry/node`, `@sentry/nestjs` e `prom-client` estão instaladas e configuradas, e o observability descrito no `.env.production` não existe em execução.

---

## 2. Segurança

### 2.1 Crítico — o segredo JWT está publicado neste repositório

`configuration.ts` valida as variáveis de ambiente e devolve um objeto com chaves em **camelCase**:

```ts
jwtSecret: z.string().min(32),
```

Mas quem assina e quem verifica os tokens pede a chave em **SCREAMING_SNAKE**:

```ts
// auth.module.ts
secret: configService.get<string>('JWT_SECRET') || 'your-secret-key-change-in-production',

// jwt.strategy.ts
secretOrKey: configService.get<string>('JWT_SECRET') || 'your-secret-key-change-in-production',
```

`configService.get('JWT_SECRET')` retorna `undefined`, porque a chave carregada se chama `jwtSecret`. Os dois lados caem no fallback, então **o sistema funciona** — assinando e verificando com a string literal `'your-secret-key-change-in-production'`, que está no código-fonte de um repositório público.

Consequência: qualquer pessoa pode forjar um JWT válido para qualquer instalação do TAPS, escolhendo o `sub` (o `bakerId`) que quiser, e obter acesso autenticado. Definir `JWT_SECRET` corretamente no ambiente **não corrige**, porque o valor nunca é lido.

A mesma inversão vale para `ENCRYPTION_SECRET` (`encryptionSecret` no config, `'change-this-in-production'` no fallback de `security.config.ts`).

**Correção mínima:** usar as chaves reais (`config.get('jwtSecret')`), **remover todos os fallbacks** e falhar na inicialização se o segredo não existir. Um sistema de pagamentos não deve subir com um segredo padrão — deve recusar-se a subir.

### 2.2 Crítico — o endpoint de verificação de carteira sempre aprova

```ts
@Post('verify-wallet')
@UseGuards(JwtAuthGuard)
async verifyWalletPassphrase(@CurrentUser() user, @Body() dto: VerifyWalletDto) {
  // This would typically use the WalletAuthGuard
  // For now, just return success if endpoint is reached
  return { valid: true };
}
```

Retorna `{valid: true}` para qualquer passphrase, inclusive nenhuma. Existe um `WalletAuthGuard` correto no repositório, e ele não é usado aqui. Se um frontend usar esse endpoint para liberar uma ação sensível, a checagem é totalmente contornável.

### 2.3 Crítico — criptografia da carteira

`WalletEncryptionService` guarda a passphrase da carteira do baker. Problemas, em ordem de gravidade:

**Salt fixo e literal no KDF:**
```ts
const key = crypto.scryptSync(password, 'salt', this.KEY_LENGTH);
```
O salt é a string `'salt'`. Todos os usuários, de todas as instalações, derivam chave com o mesmo salt — o que anula o propósito do salt e viabiliza tabelas pré-computadas.

**AES-256-CBC sem autenticação.** Sem HMAC nem tag: o ciphertext é maleável e sujeito a padding oracle. Para uma seed de carteira, isso é inaceitável. O próprio repositório já tem a implementação certa — `WalletService` usa AES-256-GCM com salt aleatório. São duas implementações concorrentes e incompatíveis, e a pior é a que está no caminho da passphrase.

**Hash de verificação é SHA-512 de uma rodada:**
```ts
crypto.createHash('sha512').update(passphrase + salt).digest('hex')
```
Rápido por design, portanto ideal para força bruta offline. Deveria ser Argon2id.

**Comparação não é em tempo constante:** `computedHash === hash.toUpperCase()` — canal lateral de tempo. Use `crypto.timingSafeEqual`.

**A "dupla criptografia" não protege nada.** O modelo guarda `phrase` (cifrada só com a senha do usuário) **e** `appPhrase` (cifrada com senha + app seed). Como as duas ficam armazenadas, a camada extra é irrelevante: basta usar a primeira. E o `schema.prisma` guarda `appPassphrase` **na mesma linha da mesma tabela** que `encryptedPassphrase`. Quem lê o banco tem as duas camadas.

**Limite de coluna insuficiente:** `encryptedPassphrase String? @db.VarChar(255)`. Uma mnemônica de 24 palavras (~150 caracteres) cifrada e serializada em hex passa de 300 caracteres antes mesmo da segunda camada. O insert falha ou trunca.

**`clearSensitiveData()` é um placebo:**
```ts
for (let i = 0; i < data.length; i++) {
  // @ts-ignore
  data[i] = '\0';
}
```
Strings em JavaScript são imutáveis; o laço não faz nada. E o docstring da classe afirma "Memory is cleaned after sensitive operations". Uma garantia de segurança documentada que não existe é pior que a ausência dela.

**Recomendação de fundo:** guardar uma chave `edsk` quente num banco de dados é o modelo de maior risco possível para um sistema de payout. O padrão do ecossistema Tezos é um **remote signer** (`octez-signer`) ou Ledger, com política de gasto, de modo que o backend nunca vê a chave. Isso deveria entrar no roadmap como mudança de arquitetura, não como melhoria incremental.

### 2.4 Alto — autenticação

- **Enumeração de usuário por tempo:** `login()` retorna `UnauthorizedException` imediatamente quando o usuário não existe, sem executar o `bcrypt.compare`. A diferença de tempo revela quais usuários existem. Correção: comparar sempre contra um hash dummy.
- **Rate limit de login não está aplicado.** `RATE_LIMIT_CONFIG.auth` define 5 tentativas por 15 minutos, e nenhum `@Throttle` usa esse valor. Vale apenas o global de 10 req/min. Não há bloqueio de conta nem contagem de falhas.
- **`logout` não faz nada** — sem blacklist, sem `jti`. Token de 24h continua válido.
- **Trocar a senha não invalida os tokens existentes.**
- **`bcrypt` trunca em 72 bytes** e `validatePasswordStrength` não impõe comprimento máximo.
- **Sem 2FA/TOTP** num sistema que movimenta fundos.
- `findUserByUsername` faz `settingsRepo.findAll()` e filtra em memória — e é chamado **duas vezes** por login. Além do custo, `userName` não tem índice único no schema, então nomes duplicados são possíveis.
- Rounds de bcrypt inconsistentes: 12 em `PasswordService`, 10 em `WalletService`.

### 2.5 Médio

- `.env.development`, `.env.staging` e `.env.production` estão versionados. Os valores são placeholders `${VAR}`, mas o padrão convida ao vazamento.
- CSP permite `'unsafe-inline'` em `styleSrc`.
- CORS de produção cai no literal `'https://yourdomain.com'`.
- `POST /jobs/trigger/*` dispara distribuição protegido só por JWT, sem `WalletAuthGuard`.
- `npm audit --audit-level=high` roda com `continue-on-error: true` — o portão de segurança é decorativo.
- Sem tabela de auditoria: não há registro de quem disparou um pagamento, quando, de qual IP.

---

## 3. Correção financeira

Esta é a seção mais importante. Os itens abaixo podem causar pagamento duplicado, pagamento a menos ou ausência de pagamento.

### 3.1 Pagamento duplicado por retry

`PaymentDistributorService.distributeCycleRewards()` tem um laço de retry:

```ts
while (!blockchainConfirmed && retriesUsed < maxRetries) {
  retriesUsed++;
  if (retriesUsed > 1) await this.clearPreviousAttempt(bakerId, cycle);
  try {
    const result = await this.executeDistribution(...);
    blockchainConfirmed = result.applied;
  } catch (error) {
    errors.push(...);   // e tenta de novo
  }
}
```

Se `sendBatchTransaction` lançar exceção **depois** da operação ter sido injetada — timeout de confirmação, queda do RPC, resposta perdida — o batch já está na cadeia. O `catch` engole, e a próxima iteração **injeta o mesmo pagamento outra vez**. Pior: `clearPreviousAttempt()` apaga os registros da tentativa anterior, destruindo a evidência.

Não há, em nenhum ponto, uma consulta ao hash da operação anterior antes de reenviar.

**Correção:** persistir a intenção de pagamento com um `opHash` antes de considerar a tentativa encerrada, e nunca reenviar sem antes verificar o estado on-chain do hash anterior via TzKT.

### 3.2 O banco permite pagar o mesmo ciclo várias vezes

```prisma
@@unique([bakerId, cycle, date, result])           // Payment
@@unique([bakerId, cycle, address, date, result])  // DelegatorPayment
```

Incluir `date` e `result` na chave natural significa que o mesmo baker pode ter várias linhas para o mesmo ciclo, bastando outra data ou outro status. A restrição que faria o banco impedir pagamento duplicado — `@@unique([bakerId, cycle])` — não existe.

Somado a isso: `updatePaymentRecords()` só atualiza se já houver linha (`if (payments.length > 0)`). Se não houver, um pagamento bem-sucedido **não deixa registro nenhum**, e a execução seguinte paga de novo.

### 3.3 Bakers com mais de 100 delegadores não conseguem pagar

`executeDistribution()` chama `sendBatchTransaction()` diretamente, que rejeita acima de `MAX_BATCH_SIZE = 100`. Existem `splitBatch()` e `sendMultipleBatches()` prontos no `TransactionService`, e **nenhum dos dois é chamado**.

E mesmo `sendMultipleBatches` não seria seguro hoje: se o lote 3 de 10 falhar, ele lança sem registrar quais lotes já foram enviados. Reexecutar paga os lotes 1 e 2 novamente.

Além disso, 100 transferências num único batch provavelmente estoura `hard_gas_limit_per_operation`; o código não confere isso contra as constantes da cadeia.

### 3.4 `storageLimit: 0` derruba o batch inteiro

```ts
batch.withTransfer({
  to: transfer.to,
  amount: mutezToTez(transfer.amount),
  storageLimit: 0,   // No storage needed for simple transfers
});
```

O comentário está errado. Transferir para uma conta ainda **não alocada** consome storage (burn de alocação). Com `storageLimit: 0` essa transferência falha — e como é um batch, **o lote todo falha e ninguém recebe**. Um único delegador novo trava a distribuição do ciclo.

### 3.5 Precisão: `Decimal.js` está presente, e os floats também

`tezos.config.ts`:
```ts
export function tezToMutez(tez: number): number {
  return Math.floor(tez * TEZOS_CONSTANTS.MUTEZ_PER_TEZ);
}
export function mutezToTez(mutez: number): number {
  return mutez / TEZOS_CONSTANTS.MUTEZ_PER_TEZ;
}
```

Ambas operam em `number` (ponto flutuante IEEE-754). `Math.floor(0.29 * 1_000_000)` dá 289999, não 290000. O caminho de pagamento passa por essas funções — `mutezToTez` é chamada para cada transferência do batch — então o erro é sistemático e sempre para baixo.

O código usa `Decimal.js` no cálculo e depois converte para float na borda, o que anula o cuidado. **A representação canônica deveria ser `bigint` em mutez, do começo ao fim**, com Taquito recebendo `mutez: true` e valores inteiros. Formatação em XTZ só na exibição.

Relacionado: `RewardCalculatorService` chama `Decimal.set({...})` no construtor, alterando a configuração **global** do Decimal.js para todo o processo. Deveria usar `Decimal.clone()`.

### 3.6 Sem verificação de saldo, sem valor mínimo

- Em nenhum ponto se confere que o saldo da carteira cobre o total + taxas antes de enviar.
- Não há valor mínimo de pagamento. Um delegador com direito a 0,000012 XTZ entra no batch, custando mais em taxa do que o valor pago. Ferramentas de payout do ecossistema tratam isso como configuração básica.

### 3.7 Constantes de cadeia congeladas

```ts
BLOCKS_PER_CYCLE: 4096,
CYCLES_UNTIL_DELIVERED: 5,
DEFAULT_GAS_LIMIT: 15400,
DEFAULT_TRANSACTION_FEE: 0.0018,
```

São valores da era pré-2020. Duração de ciclo, delay de direitos e precificação de gas mudaram várias vezes desde então. Existe um `getConstants()` em `TezosClientService` que leria isso da cadeia — e o resto do código não o usa. Além disso, o próprio `getConstants()` lê `constants.endorsers_per_block` e `constants.time_between_blocks`, campos que **deixaram de existir** com Tenderbake.

`CYCLES_UNTIL_DELIVERED = 5` errado significa calcular o ciclo errado: ou pagar antes das recompensas estarem finalizadas, ou atrasar sem motivo.

### 3.8 Adaptive Issuance não é tratado

Desde a introdução de Adaptive Issuance e staking, um delegador pode **stakear** diretamente, e o baker tem um `edge` sobre o rendimento stakeado. `staked_balance` e `delegated_balance` rendem de forma diferente. O `RewardCalculatorService` não distingue os dois — ele confia num campo `reward` que a API nem retorna. Qualquer implementação nova precisa calcular as duas parcelas separadamente.

Relacionado: os padrões de endereço em `tezos.config.ts` cobrem `tz1`, `tz2`, `tz3` e `KT1`, mas **não `tz4`**. Um delegador com endereço `tz4` é rejeitado por `isValidTezosAddress()`.

### 3.9 Paginação silenciosa da TzKT

`/v1/rewards/split/{baker}/{cycle}` e `/v1/delegates/{id}/delegators` paginam (padrão 100). O cliente não passa `offset`/`limit` e não itera. Um baker com 250 delegadores vê 100 — **sem nenhum aviso**. Truncamento silencioso num caminho de pagamento é a pior categoria de bug: o sistema reporta sucesso.

### 3.10 O endpoint manual ignora o ciclo pedido

```ts
@Post('distribute/:cycle')
async distributeCycleRewards(@CurrentUser() user, @Param('cycle', ParseIntPipe) cycle: number) {
  const result = await this.distributionOrchestrator.processRewardsDistribution(user.sub);
```

O parâmetro `cycle` é validado e depois **descartado**. O orquestrador decide sozinho qual ciclo processar. O operador pede para pagar o ciclo 800 e o sistema paga outro. E o `catch` devolve HTTP 200 com `success: false`, escondendo a falha de clientes que só checam o status.

### 3.11 Outros

- `maxRetries = settings.paymentRetries`, cujo default é **1**. Com `while (retriesUsed < maxRetries)`, isso dá exatamente uma tentativa — o recurso de retry está efetivamente desligado, com nome que sugere o contrário.
- `saveDelegatorPayments()` grava status `APPLIED` **antes** de enviar. Um crash entre gravar e enviar deixa registros permanentemente errados.
- Escritas N+1 sem transação: um `create` por delegador em laço, depois um `update` por delegador em laço. Falha no meio deixa estado parcial.
- `CycleDetectorService.getPendingRewardsCycle()` chama `paymentsRepo.findByStatus(REWARDS_PENDING)` **sem filtrar por baker** — numa instalação multi-baker, o job de um baker processa o ciclo pendente de outro.
- `DelegatorPaymentStatus.NOT_AVAILABLE = 'not available'` (com espaço) versus o enum Prisma `not_available` (com underscore). O valor é rejeitado na escrita.
- `PaymentDistributorService.initializeWallet()` monta `{ciphertext, iv, salt, tag}` a partir de colunas gravadas por `WalletEncryptionService`, que usa outro formato (`{phrase, appPhrase, walletHash, walletSalt}`). O parâmetro é tipado `any`, escondendo o erro. Não funciona em execução.
- `onDelete: Cascade` de `Settings` para `Payment`: apagar as configurações de um baker apaga **todo o histórico financeiro**. Registro financeiro deveria ser `Restrict`.
- `BondPoolMember.amount` é `Decimal(20,2)` — duas casas decimais para um valor em XTZ, que precisa de seis.
- Cache do `TzKTClientService` é um `Map` sem limite e sem evicção — vazamento de memória, e sujeito a stampede em requisições concorrentes.
- `estimateBatchGas()` faz uma chamada RPC por transferência, em série. Taquito tem `estimate.batch()`.
- Failover de RPC em `executeWithRetry()` faz `this.tezos = new TezosToolkit(nextRpc)`, **descartando o signer** configurado.
- `WalletService.validateMnemonic()` só conta palavras (12/15/18/21/24). Sem wordlist e sem checksum BIP-39, uma palavra digitada errada gera silenciosamente **outra carteira válida**.
- `InMemorySigner.generateMnemonic()` é chamado em `WalletService.generateMnemonic()` — não é uma API pública documentada do `@taquito/signer`; a geração BIP-39 vem de `bip39`. Verificar.

---

## 4. CI/CD e infraestrutura

- **Node 18** no CI — fora de suporte desde abril de 2025.
- **`actions/upload-artifact@v3` e `download-artifact@v3`** foram desativados pelo GitHub. Os passos falham independentemente do resto.
- **`github/codeql-action/upload-sarif@v2`** também está depreciado.
- **`npm audit` com `continue-on-error: true`** — nunca bloqueia.
- Os jobs de deploy pressupõem clusters ECS (`taps-staging`, `taps-production`), task definitions (`taps-migration`, `taps-backup`) e domínios `*.example.com` que aparentemente não existem.
- `git tag` + `git push origin --tags` a cada deploy de produção, sem credencial configurada para isso.
- **Deriva de configuração séria:** `.env.production` define `JWT_EXPIRES_IN`, `WALLET_ENCRYPTION_KEY`, `WALLET_ENCRYPTION_IV`, `CORS_ORIGIN`, `RATE_LIMIT_TTL`, `ENABLE_SWAGGER`, `CSRF_PROTECTION` e mais de vinte outras variáveis que **não existem em `configuration.ts`**. O arquivo é documentação aspiracional, não configuração real.
- Endpoints RPC desatualizados: `mainnet.api.tez.ie`, `mainnet.smartpy.io`, `rpc.ghostnet.teztnets.xyz` — todos com problemas de disponibilidade hoje. Além disso, `TezosNetwork.CUSTOM` existe no enum mas não em `NETWORK_CONFIG`, então usá-lo lança exceção; e o zod de `configuration.ts` só aceita `mainnet`/`ghostnet`, impedindo RPC próprio.
- Nomes de variável divergentes entre `configuration.ts` e `getTezosConfig()`: `NUM_BLOCKS_TO_WAIT` vs `NUM_BLOCKS_WAIT`, `BLOCK_EXPLORER_URL` vs `BLOCK_EXPLORER`. Os valores caem no default silenciosamente.
- **Dois sistemas de configuração paralelos**: `ConfigService` do Nest e `getTezosConfig()` lendo `process.env` direto. Sem fonte única de verdade.

### Dependências desatualizadas

| Pacote | No repo | Observação |
|---|---|---|
| `@nestjs/*` | ^10 | NestJS 11 disponível |
| `@taquito/*` | ^17.3.2 | Muito atrás; Taquito evoluiu bastante e o suporte a Adaptive Issuance/staking está nas versões novas |
| `@prisma/client` / `prisma` | ^5.7 | Prisma 6 disponível |
| `@sentry/node`, `@sentry/nestjs` | ^7.91 | Séries 8/9 disponíveis |
| `bull` / `@nestjs/bull` | ^4 / ^10 | BullMQ é o sucessor |
| `date-fns` | ^2.30 | v4 disponível |
| `reflect-metadata` | ^0.1.14 | 0.2.x recomendado no Nest atual |
| `eslint` | ^8.56 | v9 (flat config) disponível |

A atualização do Taquito é a mais urgente: é ela que traz o suporte ao modelo econômico atual da Tezos.

---

## 5. Testes

Há ~4.200 linhas de teste com estrutura correta (unit, integration, api, security, load, fixtures) e thresholds de cobertura configurados (70% global, 80% em `rewards/services`).

O problema é o mesmo do resto: **os testes exercitam interfaces que o código não implementa**. Como `validateCalculation()` é trivialmente verdadeira e o cliente TzKT devolve zeros sem erro, os testes de cálculo de recompensa podem passar com o sistema retornando zero para todos.

O que falta, e é específico deste domínio:

- **Testes de idempotência**: rodar a mesma distribuição duas vezes e afirmar que o segundo envio não acontece.
- **Testes contra a API real da TzKT** (contract tests), que quebrariam quando o formato mudasse — exatamente a falha de 1.3.
- **Testes de propriedade sobre a aritmética**: soma dos pagamentos ≤ recompensa total, nenhuma perda de mutez no arredondamento, para entradas aleatórias.
- **Um teste end-to-end contra Ghostnet** pagando delegadores de verdade em testnet.
- **Testes de conta não alocada** (o caso do `storageLimit: 0`).

---

## 6. Stack proposta — TAPS Mobile

O pedido é dar ao TAPS uma versão mobile. Vale dizer com clareza qual é o produto: **o TAPS mobile não é um app de operação, é um app de acompanhamento e aprovação.** Um baker não configura fee por delegador nem importa CSV no celular. O que ele precisa no bolso é: saber que o ciclo virou, ver quanto vai sair, aprovar (ou não), e confirmar que saiu.

### 6.1 Proposta

| Camada | Escolha | Por quê |
|---|---|---|
| Framework | **React Native + Expo** (SDK atual) | Compartilha domínio TypeScript com o backend e com o Tezzet web |
| Navegação | **Expo Router** | Rotas por arquivo, deep linking para notificações |
| Estado servidor | **TanStack Query** | O app é majoritariamente leitura de estado remoto |
| Estilo | **Tokens de `suite/tokens/tokens.json`** via tema tipado | Ver seção 7 |
| Tipos da API | **Gerados do OpenAPI** que o Swagger do NestJS já produz | Elimina a classe de erro descrita em 1.2 |
| Autenticação | **JWT curto + refresh**, token no `expo-secure-store` | Nunca `AsyncStorage` |
| Aprovação | **Biometria local** (`expo-local-authentication`) sobre a passphrase da carteira | A aprovação de payout é a ação de maior valor do app |
| Push | **Expo Notifications** | Virada de ciclo, payout concluído, payout falhou, saldo insuficiente |
| Precisão | **`bigint` em mutez**, formatação só na borda | Mesma regra do backend |
| Testes | **Jest + React Native Testing Library**, **Maestro** para E2E | |

### 6.2 Escopo do app

**Fase 1 — somente leitura.** Saldo da carteira, ciclo atual, próximo payout com valor estimado, histórico de pagamentos, detalhe por delegador, link para o explorador. Nenhuma ação. Já é útil e tem risco quase zero.

**Fase 2 — notificações.** Alertas de virada de ciclo, payout concluído/falho, saldo insuficiente antes do próximo ciclo. Esse é o valor real para um baker: hoje ele descobre que o payout falhou quando um delegador reclama.

**Fase 3 — aprovação.** Modo "requer aprovação": o backend calcula e segura; o app mostra o resumo (total, número de delegadores, taxa estimada, saldo restante) e o baker aprova com biometria. Isso melhora a **segurança do produto todo**, porque troca payout automático com chave quente por payout com confirmação humana.

**Fase 4 — configuração leve.** Alternar modo (off/simulação/on), ajustar fee padrão, fee individual de um delegador. Sempre com confirmação.

### 6.3 Pré-requisito

O app mobile depende de uma API que funcione. **Não faz sentido começar o mobile antes das seções 1, 2 e 3 estarem resolvidas** — construir um cliente sobre uma API que não compila, cujo cálculo retorna zero e cujo JWT é forjável apenas amplia a superfície do problema.

---

## 7. Interface: padronização com o Tezzet

Ver `suite/` no repositório **tezzet** — é o espaço unificado de marca, narrativa e tokens de design dos dois produtos, com `suite/index.html` como referência viva.

O que o TAPS consome de lá: os tokens (`tokens.json` / `tokens.css`), o kit de componentes específicos de Tezos (valor em XTZ, endereço truncado, hash de operação, badge de status, número de ciclo, seletor de rede) e as regras de escrita em português.

Além do ganho visual, há um ganho técnico direto: hoje o TAPS não tem frontend nenhum, então padronizar **antes** de escrever o primeiro componente evita a divergência em vez de ter que corrigi-la depois.

---

## 8. Prioridades

**Bloqueante — nada roda sem isto**
1. Corrigir os identificadores duplicados em `tzkt-client.service.ts`; ligar `strict: true`; fazer `npm run build` passar.
2. Gerar e commitar as migrations do Prisma.
3. Corrigir a leitura de configuração (`jwtSecret` e não `JWT_SECRET`) e **remover todos os fallbacks de segredo**; falhar na inicialização se ausentes.
4. Registrar `MonitoringModule` no `AppModule`.
5. Reescrever `TzKTClientService` contra o contrato atual da TzKT, com paginação e **sem `|| 0`** — falhar alto quando um campo esperado não vier.

**Crítico — antes de tocar em dinheiro real**
6. Idempotência: `@@unique([bakerId, cycle])`, registro do `opHash` antes de considerar a tentativa encerrada, e verificação on-chain antes de qualquer reenvio.
7. Remover `storageLimit: 0`; estimar via `estimate.batch()`.
8. Usar `splitBatch`/`sendMultipleBatches` com registro por lote.
9. `bigint` em mutez em todo o caminho de valor.
10. Verificação de saldo e valor mínimo de pagamento.
11. Corrigir `verify-wallet`; aplicar `WalletAuthGuard` onde é devido.
12. Trocar `WalletEncryptionService` por AES-256-GCM com salt aleatório e Argon2id — ou eliminá-lo em favor do `WalletService`, que já está correto.
13. Ler as constantes da cadeia em vez de usar os valores fixos.

**Alto**
14. Suporte a Adaptive Issuance / staking no cálculo; aceitar `tz4`.
15. Atualizar Taquito, NestJS, Prisma; consertar o CI (Node LTS atual, actions v4).
16. Rate limit de login, bloqueio de conta, revogação de token, 2FA.
17. Contract tests contra a TzKT e um E2E de payout em Ghostnet.
18. Tabela de auditoria.

**Médio**
19. Avaliar remote signer / Ledger no lugar da chave quente em banco.
20. Consertar `README.md`, que ainda descreve a instalação em ColdFusion/Lucee de um sistema que não existe mais.
21. Fonte única de configuração; remover `.env.*` do versionamento.
22. Iniciar o mobile.
