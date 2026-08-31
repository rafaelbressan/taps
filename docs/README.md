# Documentação do TAPS

**Este diretório é o ponto de entrada do conhecimento do projeto.** Tudo que é decisão, análise ou especificação está indexado aqui e vive na `master`.

A regra, escrita para não se perder: **código pode viver em branch enquanto a stack não fecha; conhecimento não.** Decisão registrada só em branch de agente não registra decisão nenhuma.

## Regras de negócio e análise

| Documento | O que é |
|---|---|
| [`spec/REGRAS-DE-NEGOCIO.md`](spec/REGRAS-DE-NEGOCIO.md) | As regras de negócio do TAPS extraídas do sistema original. O aproveitamento literal de código é próximo de zero; **o que sobrevive são as regras**, e elas estão aqui |
| [`../ANALYSIS.md`](../ANALYSIS.md) | O que impede o sistema de rodar, os achados de segurança, e os de correção financeira — pagamento duplicado, precisão, constantes congeladas |
| [`../migration-docs/`](../migration-docs/) | Documentação da migração ColdFusion → TypeScript. `BUSINESS_LOGIC.md` descreve o comportamento do sistema original |
| [`tezos-network-facts.md`](tezos-network-facts.md) | O que a rede Tezos faz **hoje**, com a chamada que comprova cada número. Base factual da camada de cadeia |

## Código

| Diretório | O que é |
|---|---|
| [`../packages/tezos-chain/`](../packages/tezos-chain/) | `@tezos-suite/chain` — a camada de cadeia da suíte, compartilhada com o Tezzet. Especificada em SPEC-0002. Não importa nada do TAPS: extrair para repositório próprio é um `git mv` |
| [`../packages/payout-engine/`](../packages/payout-engine/) | `@tezos-suite/payout` — o motor de payout (BRES-46). Idempotência por desenho: o hash existe antes da operação, nada é reenviado sem ler o estado do hash anterior na cadeia, e o banco impede a segunda distribuição do mesmo ciclo |
| `../backend/` | O backend NestJS herdado. Não compila, e a reescrita passa por cima dele (ADR-0001 §6). A camada de cadeia dele é substituída pelo pacote acima |

## Documentos de suíte

Valem para o TAPS **e** para o Tezzet, e moram no repositório do **Tezzet**, ao lado de `suite/`.

| # | Documento | Onde |
|---|---|---|
| ADR-0001 | Stack unificada da Suíte Tezos | `tezzet` → `docs/adr/0001-stack-unificada-tezzet-taps.md` |
| SPEC-0001 | Núcleo criptográfico compartilhado (`tz-keys` + `tz-vault`) | `tezzet` → `docs/spec/0001-nucleo-criptografico-compartilhado.md` |
| SPEC-0002 | Camada de cadeia (`@tezos-suite/chain`) | `tezzet` → `docs/spec/0002-camada-de-cadeia.md` |

O que a SPEC-0001 decide especificamente para o TAPS está resumido em [`spec/README.md`](spec/README.md) — inclusive a custódia da chave de payout, que está **decidida**.

## Operação

| Documento | O que é |
|---|---|
| [`deployment/DEPLOYMENT_RUNBOOK.md`](deployment/DEPLOYMENT_RUNBOOK.md) | Runbook de deploy do sistema atual |
| [`deployment/TROUBLESHOOTING.md`](deployment/TROUBLESHOOTING.md) | Diagnóstico do sistema atual |
| [`deployment/BAKINGNET-PAYOUT-VALIDATION.md`](deployment/BAKINGNET-PAYOUT-VALIDATION.md) | O combinado para fechar o payout em Bakingnet: como subir o `octez-signer` (metade do Rafael) e como rodar o harness contra o motor de produção |

Os dois descrevem o TAPS como serviço de nuvem. A ADR-0001 §4 recomenda **local-first**; quando isso for decidido, estes dois documentos são reescritos.
