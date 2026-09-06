//! A ponte para o `octez-signer`, e a credencial de cliente.
//!
//! O que o TAPS guarda é a **chave de cliente** do signer — a que prova quem
//! está pedindo. Ela não é a chave que segura os fundos, não produz assinatura
//! Tezos de transferência nenhuma, e uma máquina que só tem ela não move nada.
//! A chave de payout vive no host do `octez-signer` e nunca chega aqui: nem
//! coluna de banco, nem arquivo, nem variável de ambiente (SPEC-0001 §11,
//! decisão de custódia de 2026-08-28).
//!
//! A credencial fica no **cofre de credenciais do sistema operacional** —
//! Secret Service no Linux, Credential Manager no Windows — e não num arquivo
//! deste aplicativo. O motivo é o mesmo pelo qual o núcleo criptográfico não
//! foi reescrito aqui: cifra de armazenamento é território do Tezos Core &
//! Crypto, e delegar ao cofre do sistema é composição, não criptografia nova.
//! Consequência que precisa estar escrita: ela **não** entra no backup do
//! banco, e restaurar um backup noutra máquina exige configurar a credencial
//! de novo. Isso é de propósito.
//!
//! O HTTP para o signer sai daqui, não da webview. Duas razões: o certificado
//! do signer costuma ser próprio do baker, e a `connect-src` da CSP pode
//! continuar fechada para o resto da internet.

use serde::{Deserialize, Serialize};

const SERVICE: &str = "rio.tezos.taps";
const ACCOUNT: &str = "octez-signer-client-auth";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignerResponse {
    pub status: u16,
    pub body: String,
}

/// Lê a credencial de um arquivo e a guarda no cofre do sistema.
///
/// O caminho vem do diálogo nativo de arquivo, e o segredo **não atravessa para
/// o JavaScript**: o requisito 9 da ADR-0001 manda que segredo não nasça de um
/// `<input>` de HTML, e a forma de obedecer sem escrever um prompt nativo por
/// plataforma é não pedir o texto — pedir o arquivo.
///
/// O arquivo é o que o `octez-signer gen keys` deixou no host do baker. Depois
/// de importado, ele pode ser apagado: o cofre do sistema passa a ser a cópia.
pub fn import_credential_from_file(path: &str) -> Result<(), String> {
    let content = std::fs::read_to_string(path).map_err(|error| {
        format!("não consegui ler {path} ({error}) — confira o caminho e a permissão do arquivo")
    })?;
    // Aceita tanto o arquivo com só a chave quanto uma linha `unencrypted:edsk…`,
    // que é como o octez-signer escreve em `secret_keys`.
    let candidate = content
        .split_whitespace()
        .find_map(|token| {
            token
                .rsplit(':')
                .next()
                .filter(|value| value.starts_with("edsk"))
        })
        .ok_or_else(|| {
            format!(
                "não achei uma chave começando por \"edsk\" em {path} — este arquivo não parece \
                 ser a credencial de cliente do signer"
            )
        })?
        .to_string();
    store_credential(&candidate)
}

pub fn store_credential(secret: &str) -> Result<(), String> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err("a credencial veio vazia".to_string());
    }
    if !trimmed.starts_with("edsk") {
        return Err(
            "a credencial de cliente do signer é uma chave Ed25519 em base58 começando por \
             \"edsk\" — confira o que o comando `octez-signer gen keys` devolveu"
                .to_string(),
        );
    }
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(describe_keyring)?
        .set_password(trimmed)
        .map_err(describe_keyring)
}

pub fn credential_present() -> bool {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .and_then(|entry| entry.get_password())
        .is_ok()
}

/// Entrega a credencial ao processo que vai assinar o pedido de autenticação.
///
/// Ela atravessa para o JavaScript porque é lá que mora o
/// `Ed25519ClientAuthenticator` que o Tezos Core & Crypto já revisou (BRES-74),
/// e uma segunda implementação em Rust seria criptografia nova escrita fora
/// daquela revisão. Fica em memória, nunca em disco, e some com a janela.
pub fn reveal_credential() -> Result<String, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(describe_keyring)?
        .get_password()
        .map_err(|_| {
            "não há credencial de cliente do signer guardada nesta máquina — \
             abra Configuração e cadastre a chave que você autorizou no `octez-signer`"
                .to_string()
        })
}

pub fn forget_credential() -> Result<(), String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(describe_keyring)?
        .delete_credential()
        .map_err(describe_keyring)
}

/// Uma chamada ao signer. `url` já foi validada como `https://` do lado do TS.
pub async fn call(url: &str, method: &str, body: Option<String>) -> Result<SignerResponse, String> {
    if !url.starts_with("https://") {
        return Err(
            "o endereço do signer precisa ser https:// — em texto claro qualquer um no \
             caminho troca os bytes que o signer vai assinar"
                .to_string(),
        );
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // Sem redirecionamento: um 302 levaria o pedido de assinatura para
        // outro lugar sem ninguém ver.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;

    let request = match method {
        "GET" => client.get(url),
        "POST" => {
            let request = client.post(url).header("content-type", "application/json");
            match body {
                Some(payload) => request.body(payload),
                None => request,
            }
        }
        other => return Err(format!("método {other} não é usado no caminho do signer")),
    };

    let response = request.send().await.map_err(|error| {
        format!(
            "não consegui falar com o octez-signer ({error}) — confira se o daemon está no ar \
             e se foi destravado depois do último restart"
        )
    })?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(SignerResponse { status, body })
}

fn describe_keyring(error: keyring::Error) -> String {
    format!(
        "o cofre de credenciais do sistema não respondeu ({error}) — no Linux ele é o Secret \
         Service (gnome-keyring ou kwallet) e precisa estar rodando na sessão"
    )
}
