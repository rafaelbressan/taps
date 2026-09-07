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
//!
//! # Em quem este canal confia (BRES-137)
//!
//! Em **um** certificado: o do signer do baker, importado por arquivo e
//! guardado em `app_settings` sob `signer.tls_ca_pem`. Nem no conjunto da
//! Mozilla que vem no `webpki-roots`, nem no truststore do sistema. As
//! autoridades públicas não têm nada a dizer sobre um daemon em
//! `192.168.1.20`, e deixá-las opinar sobre o canal que carrega os bytes de
//! assinatura seria confiar em ~150 organizações para falar com um processo do
//! próprio baker.
//!
//! Quem valida continua sendo o rustls, com a rota inteira — assinatura,
//! validade, `subjectAltName` contra o endereço configurado. O que mudou foi o
//! conjunto de âncoras: `tls_built_in_root_certs(false)` mais o certificado
//! importado. **Não há verificador escrito à mão aqui**, e é de propósito:
//! comparar impressão digital num `ServerCertVerifier` próprio significaria
//! reimplementar validação de certificado, que é exatamente o que o padrão
//! desta suíte proíbe.
//!
//! Sem certificado importado, `call` **recusa**. Não existe o caminho "tenta
//! com as CAs públicas e vê no que dá": um canal de assinatura não herda
//! confiança que ninguém escolheu.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

// ------------------------------------------------- certificado do signer

/// O certificado que este TAPS aceita do signer, e mais nada.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedCertificate {
    /// SHA-256 do DER, no mesmo formato que
    /// `openssl x509 -noout -fingerprint -sha256` imprime no host do signer.
    ///
    /// É por aqui que o baker confere, fora de banda, que fixou o certificado
    /// certo — a única checagem que o TLS não pode fazer por ele.
    pub fingerprint: String,
    /// O PEM, para quem chama guardar em `app_settings`.
    ///
    /// Não atravessa para a janela — não porque seja segredo (não é), mas
    /// porque a tela não precisa dele para nada, e o que não atravessa não
    /// precisa ser pensado de novo depois.
    #[serde(skip)]
    pub pem: String,
}

/// Lê o certificado do signer de um arquivo e o valida.
///
/// O caminho vem do diálogo nativo, por token, pela mesma razão que o da
/// credencial: a tela não escolhe arquivo.
///
/// Recusa mais do que aceita:
///
/// - **Um PEM que o rustls não aceite como âncora** — melhor falhar na
///   importação, com o arquivo na mão, do que no primeiro pagamento.
/// - **Um arquivo que traga chave privada.** `tls.key` e `tls.crt` moram lado
///   a lado no host do signer, e um `cat` distraído junta os dois. Isso aqui
///   vai para o banco, que vai para o backup — a chave privada do TLS do
///   signer não pode entrar nesse caminho por engano.
pub fn read_certificate_from_file(path: &std::path::Path) -> Result<ImportedCertificate, String> {
    let pem = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "não consegui ler {} ({error}) — confira o caminho e a permissão do arquivo",
            path.display()
        )
    })?;
    parse_certificate(&pem).map_err(|why| format!("{} não serve: {why}", path.display()))
}

/// Valida o PEM e devolve o que o baker vai conferir.
fn parse_certificate(pem: &str) -> Result<ImportedCertificate, String> {
    if pem.contains("PRIVATE KEY") {
        return Err(
            "este arquivo traz uma chave privada junto. O TAPS quer só o certificado \
             (`tls.crt`), que é público — a chave (`tls.key`) fica no host do signer e não deve \
             sair de lá"
                .to_string(),
        );
    }
    if !pem.contains("BEGIN CERTIFICATE") {
        return Err(
            "não achei nenhum bloco `-----BEGIN CERTIFICATE-----`. O arquivo do signer é o \
             `tls.crt` que o `openssl req -x509` gerou, em PEM"
                .to_string(),
        );
    }
    // Quem diz se serve de âncora é a mesma biblioteca que vai validar a
    // conexão. Recusar aqui com outra régua seria aceitar na importação o que
    // quebra no pagamento.
    let anchors = reqwest::Certificate::from_pem_bundle(pem.as_bytes())
        .map_err(|error| format!("o rustls não aceitou este certificado ({error})"))?;
    if anchors.is_empty() {
        return Err("o arquivo não tem nenhum certificado dentro".to_string());
    }
    Ok(ImportedCertificate {
        fingerprint: fingerprint(pem)?,
        pem: pem.to_string(),
    })
}

/// SHA-256 do DER do **primeiro** certificado do arquivo.
///
/// O primeiro é o que o baker gerou — num arquivo com cadeia, é a folha ou a
/// CA que ele mesmo criou, e é dela que ele tem a impressão digital no host do
/// signer.
pub fn fingerprint(pem: &str) -> Result<String, String> {
    let body: String = pem
        .lines()
        .skip_while(|line| !line.contains("BEGIN CERTIFICATE"))
        .skip(1)
        .take_while(|line| !line.contains("END CERTIFICATE"))
        .map(str::trim)
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|error| format!("o corpo do PEM não é base64 válido ({error})"))?;
    Ok(Sha256::digest(&der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":"))
}

/// O cliente HTTP do canal de assinatura, com uma âncora só.
fn pinned_client(ca_pem: &str) -> Result<reqwest::Client, String> {
    let anchors = reqwest::Certificate::from_pem_bundle(ca_pem.as_bytes()).map_err(|error| {
        format!(
            "o certificado do signer guardado na configuração não é um PEM válido ({error}) — \
             importe-o de novo em Configuração"
        )
    })?;
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // Sem redirecionamento: um 302 levaria o pedido de assinatura para
        // outro lugar sem ninguém ver.
        .redirect(reqwest::redirect::Policy::none())
        // O ponto da BRES-137: nenhuma CA pública opina sobre este canal.
        .tls_built_in_root_certs(false);
    for anchor in anchors {
        builder = builder.add_root_certificate(anchor);
    }
    builder.build().map_err(|error| error.to_string())
}

/// Diz o que aconteceu, e em particular diz "TLS" quando foi TLS.
///
/// A frase anterior culpava o daemon — "confira se o daemon está no ar" — em
/// cima de um erro de certificado, que é o único caso em que o daemon está
/// certo e a máquina do baker é que está errada. Um dia de investigação saiu
/// disso (BRES-137).
///
/// A classificação é por texto da cadeia de erros, e isso é um compromisso
/// consciente: o `rustls::Error` não atravessa o `reqwest::Error` como tipo.
/// Ela decide **o que escrever**, nunca se a conexão é aceita — errar aqui
/// custa uma frase menos precisa, não uma conexão insegura.
fn describe_transport_error(error: &reqwest::Error) -> String {
    let mut detail = error.to_string();
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(inner) = source {
        detail.push_str(" — ");
        detail.push_str(&inner.to_string());
        source = inner.source();
    }
    let lower = detail.to_lowercase();

    if lower.contains("causedasendentity") {
        return format!(
            "o signer apresentou um certificado marcado como autoridade (`CA:TRUE`) e o está \
             usando como certificado de servidor — o rustls recusa isso. Gere de novo no host do \
             signer com `basicConstraints=critical,CA:FALSE` e importe o novo arquivo aqui. \
             ({detail})"
        );
    }
    if lower.contains("not valid for name") || lower.contains("notvalidforname") {
        return format!(
            "o certificado do signer não vale para o endereço configurado. O \
             `subjectAltName` precisa trazer exatamente o endereço que está em `signer.url` — \
             `IP:` para número, `DNS:` para nome. ({detail})"
        );
    }
    if lower.contains("expired") || lower.contains("notvalidyet") {
        return format!(
            "o certificado do signer está fora da validade. Gere um novo no host do signer e \
             importe-o em Configuração. ({detail})"
        );
    }
    if lower.contains("certificate") {
        return format!(
            "o certificado que o signer apresentou não é o que está importado aqui. Ou o \
             certificado do signer foi trocado — importe o novo em Configuração —, ou você não \
             está falando com o signer que pensa. ({detail})"
        );
    }
    if error.is_timeout() {
        return format!(
            "o signer não respondeu no tempo limite ({detail}) — confira se o daemon está no ar \
             e se a porta chega até esta máquina"
        );
    }
    format!(
        "não consegui falar com o octez-signer ({detail}) — confira se o daemon está no ar e se \
         foi destravado depois do último restart"
    )
}

/// O que é conferido antes de abrir qualquer conexão, e devolve a âncora.
///
/// Está separado de `call` para poder ser testado sem rede e sem runtime: são
/// três recusas, e cada uma delas é a diferença entre um pagamento e um
/// acidente.
fn preflight<'a>(base_url: &str, ca_pem: Option<&'a str>, path: &str) -> Result<&'a str, String> {
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
    ca_pem
        .map(str::trim)
        .filter(|pem| !pem.is_empty())
        .ok_or_else(|| {
            "falta o certificado do signer nesta máquina. O TAPS confia num certificado só — o \
             seu —, e não nas autoridades públicas: elas não têm nada a dizer sobre um daemon na \
             sua rede. Abra Configuração e importe o `tls.crt` do host do signer."
                .to_string()
        })
}

/// Uma chamada ao signer. O endereço vem da configuração, nunca da tela.
///
/// `path` é conferido: só o caminho de assinatura existe neste aplicativo, e
/// um `path` que não seja ele é recusado em vez de encaminhado. Sem isso,
/// "sem parâmetro de URL" seria só mudar o lugar por onde a janela escolhe o
/// destino.
pub async fn call(
    base_url: &str,
    ca_pem: Option<&str>,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<SignerResponse, String> {
    let ca_pem = preflight(base_url, ca_pem, path)?;

    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let client = pinned_client(ca_pem)?;

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
        .map_err(|error| describe_transport_error(&error))?;
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
    use super::{collect_edsk_candidates, fingerprint, parse_certificate};

    /// Um certificado de verdade, gerado com o comando do `OCTEZ-SIGNER.md`
    /// já corrigido (`basicConstraints=critical,CA:FALSE`, `SAN IP:127.0.0.1`).
    const CERT: &str = include_str!("../test-data/signer-tls.crt");

    #[test]
    fn a_impressao_digital_e_a_mesma_que_o_openssl_imprime() {
        // `openssl x509 -noout -fingerprint -sha256 -in test-data/signer-tls.crt`
        assert_eq!(fingerprint(CERT).unwrap(), FINGERPRINT);
    }

    const FINGERPRINT: &str = include_str!("../test-data/signer-tls.sha256");

    #[test]
    fn aceita_o_certificado_do_signer() {
        let imported = parse_certificate(CERT).expect("certificado válido");
        assert_eq!(imported.fingerprint, FINGERPRINT);
        assert_eq!(imported.pem, CERT);
    }

    #[test]
    fn recusa_arquivo_com_chave_privada_junto() {
        // `tls.key` e `tls.crt` moram lado a lado; um `cat` distraído junta os
        // dois, e isto aqui vai para o banco e para o backup.
        let mixed = format!("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n{CERT}");
        let why = parse_certificate(&mixed).expect_err("tem que recusar");
        assert!(why.contains("chave privada"), "{why}");
    }

    #[test]
    fn recusa_arquivo_que_nao_e_certificado() {
        let why = parse_certificate("nada aqui\n").expect_err("tem que recusar");
        assert!(why.contains("BEGIN CERTIFICATE"), "{why}");
    }

    #[test]
    fn sem_certificado_a_chamada_nao_sai() {
        // Não existe "tenta com as CAs públicas e vê no que dá".
        for missing in [None, Some(""), Some("   ")] {
            let why = super::preflight("https://127.0.0.1:6732", missing, "/keys/tz1Vog")
                .expect_err("tem que recusar");
            assert!(why.contains("falta o certificado do signer"), "{why}");
        }
    }

    #[test]
    fn o_caminho_e_o_esquema_continuam_conferidos() {
        let why = super::preflight("http://127.0.0.1:6732", Some(CERT), "/keys/tz1Vog")
            .expect_err("http em claro não passa");
        assert!(why.contains("https://"), "{why}");

        let why = super::preflight("https://127.0.0.1:6732", Some(CERT), "/authorized_keys")
            .expect_err("só /keys/ existe neste aplicativo");
        assert!(why.contains("/keys/"), "{why}");

        assert_eq!(
            super::preflight("https://127.0.0.1:6732", Some(CERT), "/keys/tz1Vog").unwrap(),
            CERT.trim()
        );
    }

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
