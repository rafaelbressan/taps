//! A credencial de cliente do `octez-signer`, e a ponte até ele.
//!
//! **A credencial não atravessa para o JavaScript.** A versão anterior deste
//! arquivo a entregava à webview para que o `Ed25519ClientAuthenticator` do TS
//! assinasse, e o Tezos Core & Crypto reprovou (BRES-48): a webview não é
//! fronteira nenhuma — ela fala HTTP para fora, e um script que chegue até lá
//! lê o que estiver em memória. Agora a assinatura acontece deste lado, e o
//! segredo só existe entre o cofre do sistema e a pilha desta função.
//!
//! **E o que ela é, dito sem suavizar:** esta credencial *é* capacidade de
//! gasto. Com `--magic-bytes 0x03` o signer continua assinando transferência
//! para quem apresentar uma autenticação válida. As defesas do TAPS — destino
//! conferido contra a lista de delegadores, teto por ciclo, idempotência —
//! rodam **dentro** desta máquina e não alcançam quem fale direto com o
//! signer. O que a decisão de custódia elimina é a exfiltração da chave de
//! payout; o uso indevido continua sendo limitado pelo `--magic-bytes`, que
//! impede o pior caso (assinar cabeçalho de bloco e ser penalizado por dupla
//! assinatura), não pelo resto.
//!
//! A credencial fica no cofre de credenciais do sistema operacional — Secret
//! Service no Linux, Credential Manager no Windows. Consequência que precisa
//! estar escrita: ela **não** entra no backup do banco, e restaurar noutra
//! máquina exige configurá-la de novo. Isso é de propósito.
//!
//! O HTTP para o signer sai daqui, e **sem endereço vindo da tela**: o
//! endereço é lido da configuração, deste lado. Com isso a `connect-src` da
//! CSP pode ficar em `'self'` e não sobra caminho de saída pela janela.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::tezos;

const SERVICE: &str = "rio.tezos.taps";
const ACCOUNT: &str = "octez-signer-client-auth";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignerResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedCredential {
    /// O `edpk` derivado, para o baker comparar com o que autorizou no signer.
    ///
    /// É a única coisa que sai daqui, e é pública. Sem ela o baker importa um
    /// arquivo e descobre que era o errado no primeiro pagamento.
    pub public_key: String,
}

/// Lê a credencial de um arquivo e a guarda no cofre do sistema.
///
/// O caminho vem do diálogo nativo, por token — a tela não escolhe caminho, e
/// por isso não existe "leia este outro arquivo qualquer". O segredo não
/// atravessa para o JavaScript em momento nenhum: o requisito 9 da ADR-0001
/// manda que segredo não nasça de um `<input>` de HTML, e pedir o arquivo em
/// vez do texto é como se obedece sem escrever um prompt nativo por plataforma.
///
/// A validação recusa mais do que aceita, e cada recusa é um acidente real:
///
/// - **Base58check de verdade**, não "começa com edsk". Um `"unencrypted:edsk…"`
///   vindo de JSON traz a aspa junto, passa por uma checagem de prefixo, é
///   aceito pelo cofre e só quebra no primeiro pagamento.
/// - **Uma chave por arquivo.** O `secret_keys` do próprio signer tem várias, e
///   entre elas está a **chave de payout**. Pegar "a primeira que aparecer"
///   importaria justamente a chave que a decisão de custódia manda não ter
///   aqui — em silêncio.
/// - **O `edpk` derivado volta para a tela**, para o baker conferir contra o
///   que ele autorizou com `octez-signer add authorized key`.
pub fn import_credential_from_file(path: &std::path::Path) -> Result<ImportedCredential, String> {
    let content = Zeroizing::new(std::fs::read_to_string(path).map_err(|error| {
        format!(
            "não consegui ler {} ({error}) — confira o caminho e a permissão do arquivo",
            path.display()
        )
    })?);

    let candidates = collect_edsk_candidates(&content);
    match candidates.len() {
        0 => Err(format!(
            "não achei nenhuma chave Ed25519 (`edsk…`) em {} — este arquivo não parece ser a \
             credencial de cliente que você gerou com `octez-signer gen keys`",
            path.display()
        )),
        1 => store_credential(&candidates[0]),
        n => Err(format!(
            "{} traz {n} chaves. O arquivo `secret_keys` do próprio signer é assim, e uma delas \
             é a chave de pagamento — importá-la para cá seria o oposto da decisão de custódia. \
             Exporte só a credencial de cliente, num arquivo com uma chave só.",
            path.display()
        )),
    }
}

/// Todo `edsk…` distinto do arquivo, aceitando `unencrypted:edsk…`.
///
/// Recorta pelo alfabeto do base58: assim uma aspa, uma vírgula ou um `\n`
/// grudado ficam de fora em vez de entrarem na chave.
fn collect_edsk_candidates(content: &str) -> Vec<Zeroizing<String>> {
    const BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut found: Vec<Zeroizing<String>> = Vec::new();
    let bytes = content.as_bytes();
    let mut index = 0;
    while let Some(offset) = content[index..].find("edsk") {
        let start = index + offset;
        let mut end = start;
        while end < bytes.len() && BASE58.contains(bytes[end] as char) {
            end += 1;
        }
        let candidate = Zeroizing::new(content[start..end].to_string());
        if !found.iter().any(|seen| **seen == *candidate) {
            found.push(candidate);
        }
        index = end.max(start + 4);
    }
    found
}

pub fn store_credential(secret: &str) -> Result<ImportedCredential, String> {
    let seed = tezos::ed25519_seed_from_edsk(secret).map_err(|why| {
        format!(
            "a credencial de cliente do signer é uma chave Ed25519 em base58 começando por \
             \"edsk\", e esta não é: {why}"
        )
    })?;
    let public_key = tezos::ed25519_public_key(&seed);

    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(describe_keyring)?
        .set_password(secret.trim())
        .map_err(describe_keyring)?;

    Ok(ImportedCredential { public_key })
}

pub fn credential_present() -> bool {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .and_then(|entry| entry.get_password())
        .is_ok()
}

/// O `edpk` da credencial guardada, para a tela mostrar. Público, por definição.
pub fn credential_public_key() -> Result<String, String> {
    let stored = load()?;
    let seed = tezos::ed25519_seed_from_edsk(&stored)?;
    Ok(tezos::ed25519_public_key(&seed))
}

pub fn forget_credential() -> Result<(), String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(describe_keyring)?
        .delete_credential()
        .map_err(describe_keyring)
}

/// Assina o pedido de autenticação. **O único caminho que toca a credencial.**
///
/// `payload_hex` é o layout montado pelo `buildAuthenticationPayload` do
/// `@tezos-suite/payout` — `0x04 || tag || pkh || dados` —, que é a parte
/// difícil e continua revisada lá. Aqui só se faz o que não pode ser feito
/// numa webview.
pub fn authenticate(payload_hex: &str) -> Result<String, String> {
    let payload = tezos::hex_decode(payload_hex)?;
    let stored = load()?;
    let seed = tezos::ed25519_seed_from_edsk(&stored)?;
    Ok(tezos::sign_authentication(&seed, &payload))
}

fn load() -> Result<Zeroizing<String>, String> {
    let secret = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(describe_keyring)?
        .get_password()
        .map_err(|_| {
            "não há credencial de cliente do signer guardada nesta máquina — abra Configuração \
             e escolha o arquivo da chave que você autorizou no `octez-signer`"
                .to_string()
        })?;
    Ok(Zeroizing::new(secret))
}

/// Uma chamada ao signer. O endereço vem da configuração, nunca da tela.
///
/// `path` é conferido: só o caminho de assinatura existe neste aplicativo, e
/// um `path` que não seja ele é recusado em vez de encaminhado. Sem isso,
/// "sem parâmetro de URL" seria só mudar o lugar por onde a janela escolhe o
/// destino.
pub async fn call(
    base_url: &str,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<SignerResponse, String> {
    if !base_url.starts_with("https://") {
        return Err(
            "o endereço do signer precisa ser https:// — em texto claro qualquer um no caminho \
             troca os bytes que o signer vai assinar"
                .to_string(),
        );
    }
    if !path.starts_with("/keys/") {
        return Err(format!(
            "o TAPS só fala com o caminho /keys/ do signer, e este pedido foi para {path}"
        ));
    }

    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // Sem redirecionamento: um 302 levaria o pedido de assinatura para
        // outro lugar sem ninguém ver.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;

    let request = match method {
        "GET" => client.get(&url),
        "POST" => {
            let request = client.post(&url).header("content-type", "application/json");
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

#[cfg(test)]
mod tests {
    use super::collect_edsk_candidates;

    const A: &str = "edsk3W5ouBAVwo65G5fhTTtqAE3fuRx5ifHLiJ2a3HySqkX1YTWAaE";
    const B: &str = "edsk3gUfUPyBSfrS9CCgmCiQsTCHGkviBDusMxDJstFtojtc1zcpsG";

    #[test]
    fn le_a_forma_que_o_octez_signer_escreve() {
        let file = format!("[ {{ \"name\": \"client\", \"value\": \"unencrypted:{A}\" }} ]");
        let found = collect_edsk_candidates(&file);
        assert_eq!(found.len(), 1);
        // A aspa que fecha o JSON não entra na chave.
        assert_eq!(*found[0], A);
    }

    #[test]
    fn le_um_arquivo_com_a_chave_solta() {
        let found = collect_edsk_candidates(&format!("{A}\n"));
        assert_eq!(found.len(), 1);
        assert_eq!(*found[0], A);
    }

    #[test]
    fn conta_as_chaves_em_vez_de_pegar_a_primeira() {
        // É o formato do `secret_keys` do signer, onde uma das chaves é a de
        // pagamento. Duas chaves têm que ser uma recusa, não uma escolha.
        let file = format!(
            "[ {{ \"name\": \"payout\", \"value\": \"unencrypted:{A}\" }},\n  \
             {{ \"name\": \"client\", \"value\": \"unencrypted:{B}\" }} ]"
        );
        assert_eq!(collect_edsk_candidates(&file).len(), 2);
    }

    #[test]
    fn a_mesma_chave_repetida_nao_conta_duas_vezes() {
        assert_eq!(collect_edsk_candidates(&format!("{A}\n{A}\n")).len(), 1);
    }

    #[test]
    fn arquivo_sem_chave_nao_devolve_nada() {
        assert!(collect_edsk_candidates("nada aqui\n").is_empty());
    }
}
