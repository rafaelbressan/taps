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
- A custódia da chave de payout **está escalada para Rafael**. A seção 11 da SPEC escreve a recomendação (remote signer `octez-signer` ou Ledger, com o backend nunca vendo a chave) e para aí.

Nada que toque chave, semente, derivação, assinatura, KDF, cifra de armazenamento, nonce, tag ou comparação de segredo entra em `main` sem revisão de **Tezos Core & Crypto**.
