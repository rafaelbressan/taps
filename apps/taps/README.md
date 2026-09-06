# TAPS — aplicativo desktop

O TAPS distribui as recompensas de um baker Tezos aos seus delegadores. Ele
roda **na máquina do baker**: sem servidor, sem login, sem CORS, sem rate limit
e sem nenhuma porta aberta. Some a categoria inteira de problemas onde estavam
os piores achados da análise — o JWT assinado com um literal do código-fonte, o
CORS apontando para `yourdomain.com`, o pipeline apontando para
`taps.example.com`.

Stack decidida na [ADR-0001](../../../tezzet/docs/adr/0001-stack-unificada-tezzet-taps.md):
Tauri v2 + React + TypeScript, com o Rust do lado que o JavaScript não
atravessa.

Para instalar e usar, leia o [guia de instalação](../../docs/deployment/INSTALACAO.md).
Esta página é sobre o código.

## Quem é dono do quê

| Rust (`src-tauri/`) | TypeScript (`src/`) |
|---|---|
| O arquivo do banco, a conexão e a transação | O motor de payout, inteiro, do estágio 4 |
| O relógio do agendador (`tokio::interval`) | Quando pagar, quanto e para quem |
| A credencial de cliente do signer e o HTTP até ele | A montagem da operação e a leitura da cadeia |
| Backup e a troca de arquivo na restauração | A conferência do candidato antes da troca |

**Não existe lógica de dinheiro só para desktop.** O `SqlitePayoutStore`, as
migrations e o `PayoutEngine` são exatamente os do pacote; o que muda é o
caminho por onde o SQL passa. Se o driver daqui estivesse errado, os 40 testes
de contrato do pacote continuariam verdes — por isso `test/tauri-sql.test.ts`
testa a ponte separadamente.

### Por que o tique nasce no Rust

Uma webview com a janela escondida estrangula `setInterval`: o WebKitGTK e o
WebView2 fazem isso de propósito, para poupar bateria. Um agendador de payout
que só roda com a janela visível não é um agendador. O Rust emite
`taps://tick` a cada minuto e o `PayoutScheduler` — que não tem timer nenhum e
por isso é testável — decide se já é hora.

### Por que o inteiro atravessa como texto

JSON não tem inteiro de 64 bits. Um mutez acima de 2^53 que atravesse a ponte
como `number` volta errado, em silêncio. Cada valor viaja etiquetado
(`{"t":"i","v":"719997"}`) e volta a ser `bigint` de um lado e `INTEGER` do
outro.

### Onde a chave está, e onde ela não está

A chave que paga vive no host do `octez-signer` e **nunca chega a este
processo** — nem em coluna de banco, nem em arquivo, nem em variável de
ambiente. O que o aplicativo guarda é a **credencial de cliente**, que prova ao
signer quem está pedindo e não move nada sozinha. Ela fica no cofre de
credenciais do sistema operacional, entra por **arquivo escolhido no diálogo
nativo** (nunca digitada num campo da tela, conforme o requisito 9 da ADR) e
não entra no backup.

**Risco residual, escrito porque existe:** para assinar o pedido de
autenticação, a credencial atravessa para o JavaScript e fica em memória
enquanto a janela viver. A alternativa seria uma segunda implementação da
assinatura em Rust — criptografia nova, escrita fora da revisão que produziu a
que já existe. A escolha foi reusar `Ed25519ClientAuthenticator`, que é o
código revisado em BRES-74 e cujo resultado está fixado por um teste contra uma
captura de um `octez-signer` de verdade.

## Rodar

```bash
npm install
npm run dev            # http://localhost:1421
npm run tauri dev      # a janela de verdade
```

`npm install` não basta sozinho: os scripts chamam `npm run suite:fetch` antes
(via `pre*`), que busca o sistema de desenho.

## Verificar

```bash
npm run verify   # suíte + portão de desenho + tipos + testes + build + portão de bundle
```

- `check:design` reprova cor escrita à mão, `border-radius` diferente de zero e
  valor monetário tipado como `number`.
- `check:bundle` roda **depois** do build e reprova qualquer `node:` que tenha
  sobrado no pacote da webview. Um `import` novo pode trazer `FilePayoutStore`
  de volta, e o efeito é uma janela que abre em branco antes de qualquer tela
  existir — coisa que teste de unidade nenhum vê.

## Pacotes da suíte

Entram no bundle como **fonte**, por alias do Vite, e não como dependência
instalada:

- `@tezos-suite/chain` e `@tezos-suite/payout` — `packages/` deste repositório.
- `@tezos-suite/payout-store-sqlite` — pelo ponto de entrada **portátil**, que
  não tem `node:sqlite` dentro.

O sistema de desenho vem do repositório do Tezzet por commit fixo em
`suite.pin.json`, montado em `vendor/suite` (fora do git). Trocar esse commit é
revisão do Suite Design & Journey.

## Alvos

| Alvo | Como | Situação |
|---|---|---|
| Linux | `npm run tauri build --bundles deb,appimage` | verificado |
| Windows | `npm run tauri build --bundles nsis` num host Windows | **não verificado aqui** — não há máquina Windows nem toolchain MSVC nesta máquina |
| iOS / macOS | — | fora do escopo (ADR-0001 §8) |

O `.github/workflows/desktop.yml` monta os dois num runner de cada sistema.

## Desenho

Todo valor visual vem de [`suite/tokens/`](https://github.com/rafaelbressan/tezzet/tree/master/suite).
O `app.css` importa `tokens.css` direto — não há uma segunda cópia de cor,
espaço ou tipo. Dado de cadeia é monoespaçado e tabular; endereço e hash truncam
no meio, porque o fim é o checksum que a pessoa confere.
