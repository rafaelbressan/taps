# Especificações da Suíte Tezos — ponteiro

As especificações que valem para os **dois** produtos da suíte moram no repositório do **Tezzet**, ao lado das ADRs e de `suite/`, porque é de lá que vem a identidade compartilhada.

| # | Título | Onde |
|---|---|---|
| SPEC-0001 | Núcleo criptográfico compartilhado (`tz-keys` + `tz-vault`) | `tezzet` → `docs/spec/0001-nucleo-criptografico-compartilhado.md` |
| ADR-0001 | Stack unificada da Suíte Tezos | `tezzet` → `docs/adr/0001-stack-unificada-tezzet-taps.md` |

## O que a SPEC-0001 significa para o TAPS, em resumo

- O cofre `tz-vault` é **componente compartilhado**. No TAPS ele protege a **sessão do operador no console** — ele não é, e não deve virar, a resposta para a chave de payout.
- `WalletEncryptionService` (`backend/src/modules/auth/services/wallet-encryption.service.ts`) está **reprovado** por inteiro: sal literal `'salt'` no scrypt (`:151`, `:182`), AES-256-CBC sem autenticação (`:28`, `:157`), SHA-512 de uma rodada como verificador (`:121-128`) e comparação com `===` (`:138-139`). Nada ali se porta; a seção 10 da SPEC lista item por item.
- A validação de endereço passa a aceitar `tz4` — recusar um `tz4` legítimo é recusar pagar um delegador.
- **A custódia da chave de payout está decidida** (Rafael, 2026-08-28): **`octez-signer` em host separado, com allow-list de operação**. O backend do TAPS **nunca** vê a chave de payout — nenhum campo de banco, nenhum arquivo, nenhuma variável de ambiente. A seção 11 da SPEC traz a configuração exigida do signer e, principalmente, o **risco residual**: a decisão elimina a exfiltração da chave, não o uso indevido dela. Destino conferido, teto por ciclo e idempotência são do motor de payout, não do signer.
- **Auditoria externa está adiada** por decisão de Rafael. Os gatilhos que trazem a conversa de volta estão na seção 13 da SPEC — o principal é o TAPS mover fundos reais em mainnet para delegadores de terceiros.

Nada que toque chave, semente, derivação, assinatura, KDF, cifra de armazenamento, nonce, tag ou comparação de segredo entra em `main` sem revisão de **Tezos Core & Crypto**.
