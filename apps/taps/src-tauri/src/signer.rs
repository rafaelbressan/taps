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

/// Os três estados que existem de verdade.
///
/// `Absent` e `VaultDown` davam os dois `false`, e a tela dizia "falta a
/// credencial" para quem tinha a credencial e não tinha cofre — mandando o
/// baker procurar um arquivo que ele já importou.
pub enum CredentialState {
    Present,
    Absent,
    VaultDown(String),
}

pub fn credential_state() -> CredentialState {
    let entry = match keyring::Entry::new(SERVICE, ACCOUNT) {
        Ok(entry) => entry,
        Err(error) => return CredentialState::VaultDown(describe_keyring(error)),
    };
    match entry.get_password() {
        Ok(_) => CredentialState::Present,
        Err(keyring::Error::NoEntry) => CredentialState::Absent,
        Err(error) => CredentialState::VaultDown(describe_keyring(error)),
    }
}

/// O que o baker vê depois de importar a CA do signer.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedTlsCa {
    /// PEM normalizado, para o chamador gravar em `app_settings`.
    pub pem: String,
    /// Quantos certificados o arquivo trouxe. Uma cadeia é legítima.
    pub certificates: usize,
    /// SHA-256 do arquivo, em hex. É o que o baker compara com o que o
    /// `openssl x509 -fingerprint -sha256` diz no host do signer — sem isso
    /// "importei um arquivo" não prova que foi o arquivo certo.
    pub sha256: String,
}

/// Lê o `ca.crt` do disco, confere que é PEM utilizável e devolve.
///
/// Público, ao contrário da credencial de cliente: um certificado de CA não é
/// segredo e por isso vai para `app_settings`, não para o cofre. O que ele é
/// — a raiz que decide de quem esta máquina aceita uma assinatura — é o
/// motivo de ele entrar por arquivo escolhido pelo Rust e não por um campo
/// de texto da janela.
pub fn import_tls_ca_from_file(path: &std::path::Path) -> Result<ImportedTlsCa, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("não consegui ler {}: {error}", path.display()))?;
    let pem = String::from_utf8(bytes)
        .map_err(|_| "o arquivo não é texto — um `ca.crt` em PEM é texto".to_string())?;

    let roots = parse_ca_bundle(&pem)?;

    Ok(ImportedTlsCa {
        certificates: roots.len(),
        sha256: first_certificate_fingerprint(&pem)?,
        pem: pem.trim().to_string(),
    })
}

/// SHA-256 do DER do primeiro certificado, em hex minúsculo com `:`.
///
/// É o mesmo valor que `openssl x509 -in ca.crt -noout -fingerprint -sha256`
/// imprime no host do signer, e é por isso que o hash é do **DER** e não do
/// arquivo: o PEM tem quebra de linha e comentário, o DER é o certificado.
/// Comparar dois valores que não são a mesma coisa seria pior que não mostrar
/// nenhum.
fn first_certificate_fingerprint(pem: &str) -> Result<String, String> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";

    let start = pem
        .find(BEGIN)
        .ok_or_else(|| "o arquivo não tem um bloco BEGIN CERTIFICATE".to_string())?
        + BEGIN.len();
    let end = pem[start..]
        .find(END)
        .ok_or_else(|| "o bloco do certificado não termina com END CERTIFICATE".to_string())?
        + start;

    let body: String = pem[start..end]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let der = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, body)
        .map_err(|error| format!("o corpo do certificado não é base64 válido ({error})"))?;

    let digest = <sha2::Sha256 as sha2::Digest>::digest(&der);
    Ok(digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(":"))
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
        .map_err(|error| match error {
            keyring::Error::NoEntry => "não há credencial de cliente do signer guardada nesta \
                 máquina — abra Configuração e escolha o arquivo da chave que você autorizou \
                 no `octez-signer`"
                .to_string(),
            other => describe_keyring(other),
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
    tls_ca_pem: Option<&str>,
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
    let client = build_client(tls_ca_pem)?;

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

    let response = request
        .send()
        .await
        .map_err(|error| describe_send_failure(&error))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(SignerResponse { status, body })
}

/// O cliente HTTP do caminho do signer, com a raiz que o operador configurou.
///
/// **Por que isto existe (BRES-144).** `reqwest` entra aqui com a feature
/// `rustls-tls` e mais nada, o que embute o `webpki-roots` — o pacote de CAs
/// públicas da Mozilla — dentro do binário. O `OCTEZ-SIGNER.md` manda o baker
/// criar um certificado próprio, porque um signer numa LAN não tem como ter
/// certificado de CA pública. As duas coisas juntas davam um aplicativo que,
/// seguindo o runbook à risca, nunca conseguia falar com o signer: o handshake
/// morria antes do primeiro pedido de assinatura e nenhum ciclo era pago.
///
/// **E a raiz configurada SUBSTITUI as embutidas, não soma.** Um
/// `octez-signer` nunca é um host público; continuar aceitando as CAs da
/// Mozilla nesta conexão só aumentaria o conjunto de quem consegue se passar
/// por ele, sem servir a ninguém. Quem não configurar CA nenhuma continua com
/// as raízes públicas — é o caso de um signer atrás de um domínio com
/// certificado de verdade, e não há razão para quebrá-lo.
///
/// O que NÃO existe aqui, e não vai existir: `danger_accept_invalid_certs`.
/// O corpo desta requisição são os bytes que movem dinheiro, e um TLS que não
/// verifica nada é o mesmo que o HTTP em claro que a função recusa acima.
pub fn build_client(tls_ca_pem: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // Sem redirecionamento: um 302 levaria o pedido de assinatura para
        // outro lugar sem ninguém ver.
        .redirect(reqwest::redirect::Policy::none());

    if let Some(pem) = tls_ca_pem {
        let roots = parse_ca_bundle(pem)?;
        builder = builder.tls_built_in_root_certs(false);
        for root in roots {
            builder = builder.add_root_certificate(root);
        }
    }

    builder.build().map_err(|error| error.to_string())
}

/// Lê o PEM e recusa o que não for utilizável, com o motivo escrito.
///
/// Um bundle vazio é recusado explicitamente: sem isto, um arquivo de texto
/// qualquer desligaria as raízes embutidas e não colocaria nenhuma no lugar —
/// nada confiaria em nada, e o erro apareceria só no primeiro pagamento.
pub fn parse_ca_bundle(pem: &str) -> Result<Vec<reqwest::Certificate>, String> {
    let roots = reqwest::Certificate::from_pem_bundle(pem.as_bytes()).map_err(|error| {
        format!(
            "o certificado da CA do signer não é um PEM que eu consiga ler ({error}) — o \
             arquivo precisa ser o `ca.crt` gerado no Passo 3 do OCTEZ-SIGNER.md, em PEM \
             (começa com -----BEGIN CERTIFICATE-----)"
        )
    })?;
    if roots.is_empty() {
        return Err(
            "o arquivo não tem nenhum certificado dentro — escolhi não seguir com uma lista \
             de raízes vazia, porque isso desligaria a verificação sem avisar"
                .to_string(),
        );
    }
    Ok(roots)
}

/// A falha de rede, dita de forma que o baker saiba o que fazer.
///
/// O caso de certificado ganha frase própria porque o erro cru do rustls
/// (`invalid peer certificate`, `CaUsedAsEndEntity`) não diz a ninguém que a
/// resposta está na tela de Configuração.
fn describe_send_failure(error: &reqwest::Error) -> String {
    let mut chain = String::new();
    let mut source: Option<&dyn std::error::Error> = std::error::Error::source(error);
    while let Some(current) = source {
        chain.push_str(&current.to_string());
        chain.push(' ');
        source = current.source();
    }

    if chain.contains("certificate") || chain.contains("CaUsedAsEndEntity") {
        return format!(
            "o certificado do octez-signer não foi aceito ({error}) — abra Configuração e \
             importe o `ca.crt` do signer. Se você gerou o certificado com um `openssl req \
             -x509` só, ele é uma CA e o TLS recusa CA como certificado de servidor: refaça \
             pelo Passo 3 do OCTEZ-SIGNER.md, que gera CA e certificado folha separados"
        );
    }

    format!(
        "não consegui falar com o octez-signer ({error}) — confira se o daemon está no ar \
         e se foi destravado depois do último restart"
    )
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
