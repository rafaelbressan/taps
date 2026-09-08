//! O handshake TLS do caminho do signer, contra um servidor de verdade.
//!
//! **Por que este arquivo existe.** O BRES-144 foi um defeito que passou por
//! todos os portões: `reqwest` entrava com `rustls-tls` e mais nada, o que
//! embute só as CAs públicas da Mozilla, enquanto o `OCTEZ-SIGNER.md` mandava
//! o baker gerar o próprio certificado. Seguindo o runbook à risca, o
//! aplicativo não conseguia falar com o signer e nenhum ciclo era pago.
//!
//! Passou porque o único portão que tocava o signer — `Client authentication
//! against a real octez-signer` — roda no Node, com `NODE_EXTRA_CA_CERTS`. O
//! cliente do Rust nunca fazia um handshake em teste nenhum. Um teste que
//! fizesse asserção sobre a `Cargo.toml` também não teria pego: o que falha é
//! a verificação da cadeia, e isso só um servidor TLS real mostra.
//!
//! Então aqui há um servidor TLS de verdade, com certificado gerado na hora —
//! CA local e folha assinada por ela, que é a forma que o Passo 3 do runbook
//! passou a ensinar.

use std::sync::Arc;

use rcgen::{CertificateParams, DnType, IsCa, KeyPair, SanType};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::TlsAcceptor;

struct Pki {
    ca_pem: String,
    leaf_pem: String,
    leaf_key_pem: String,
}

/// CA local + folha para `127.0.0.1`. É o Passo 3 do OCTEZ-SIGNER.md em código.
fn issue() -> Pki {
    let mut ca_params = CertificateParams::new(Vec::new()).expect("parâmetros da CA");
    ca_params.is_ca = IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "taps-signer-ca-de-teste");
    let ca_key = KeyPair::generate().expect("chave da CA");
    let ca = ca_params.self_signed(&ca_key).expect("CA");

    let mut leaf_params =
        CertificateParams::new(vec!["127.0.0.1".to_string()]).expect("parâmetros da folha");
    leaf_params.subject_alt_names =
        vec![SanType::IpAddress(std::net::IpAddr::from([127, 0, 0, 1]))];
    leaf_params
        .distinguished_name
        .push(DnType::CommonName, "taps-signer");
    let leaf_key = KeyPair::generate().expect("chave da folha");
    let leaf = leaf_params
        .signed_by(&leaf_key, &ca, &ca_key)
        .expect("folha assinada pela CA");

    Pki {
        ca_pem: ca.pem(),
        leaf_pem: leaf.pem(),
        leaf_key_pem: leaf_key.serialize_pem(),
    }
}

/// O certificado que o `openssl req -x509` do runbook ANTIGO produzia:
/// auto-assinado e marcado `CA:TRUE`, servido como certificado do servidor.
///
/// Existe porque foi o que custou um dia de investigação (BRES-137). O
/// `curl` aceita, então o teste de mesa passava; o rustls recusa com
/// `CaUsedAsEndEntity`, e a mensagem antiga culpava o daemon por isso.
fn issue_ca_used_as_leaf() -> Pki {
    let mut params = CertificateParams::new(vec!["127.0.0.1".to_string()]).expect("parâmetros");
    params.is_ca = IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.subject_alt_names = vec![SanType::IpAddress(std::net::IpAddr::from([127, 0, 0, 1]))];
    params
        .distinguished_name
        .push(DnType::CommonName, "taps-signer");
    let key = KeyPair::generate().expect("chave");
    let cert = params.self_signed(&key).expect("auto-assinado CA:TRUE");
    let pem = cert.pem();

    // Fixado e servido são o mesmo arquivo: é o que o runbook mandava fazer.
    Pki {
        ca_pem: pem.clone(),
        leaf_pem: pem,
        leaf_key_pem: key.serialize_pem(),
    }
}

/// Um servidor TLS que responde uma vez e morre. Devolve a porta.
async fn serve_once(pki: &Pki, body: &'static str) -> u16 {
    let certs = rustls_pemfile_certs(&pki.leaf_pem);
    let key = rustls_pemfile_key(&pki.leaf_key_pem);

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .expect("configuração do servidor");
    let acceptor = TlsAcceptor::from(Arc::new(config));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();

    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut tls) = acceptor.accept(stream).await else {
            return;
        };
        let mut scratch = [0u8; 1024];
        let _ = tls.read(&mut scratch).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: application/json\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = tls.write_all(response.as_bytes()).await;
        let _ = tls.flush().await;
    });

    port
}

fn rustls_pemfile_certs(pem: &str) -> Vec<rustls::pki_types::CertificateDer<'static>> {
    let der = decode_pem_blocks(pem, "CERTIFICATE");
    der.into_iter()
        .map(rustls::pki_types::CertificateDer::from)
        .collect()
}

fn rustls_pemfile_key(pem: &str) -> rustls::pki_types::PrivateKeyDer<'static> {
    let mut der = decode_pem_blocks(pem, "PRIVATE KEY");
    rustls::pki_types::PrivatePkcs8KeyDer::from(der.remove(0)).into()
}

fn decode_pem_blocks(pem: &str, label: &str) -> Vec<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find(&begin) {
        let body_start = start + begin.len();
        let body_end = rest[body_start..].find(&end).expect("bloco PEM fechado") + body_start;
        let body: String = rest[body_start..body_end]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        out.push(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, body)
                .expect("base64 do PEM"),
        );
        rest = &rest[body_end + end.len()..];
    }
    out
}

#[tokio::test]
async fn com_a_ca_do_operador_o_handshake_passa() {
    let pki = issue();
    let port = serve_once(&pki, "{\"public_key\":\"edpktest\"}").await;

    let response = taps_lib::signer::call(
        &format!("https://127.0.0.1:{port}"),
        Some(&pki.ca_pem),
        "GET",
        "/keys/tz1fakefakefakefakefakefakefakcRHqXV",
        None,
    )
    .await
    .expect("o signer com CA importada tem de responder");

    assert_eq!(response.status, 200);
    assert!(
        response.body.contains("edpktest"),
        "corpo: {}",
        response.body
    );
}

#[tokio::test]
async fn sem_a_ca_o_handshake_falha_e_o_erro_diz_o_que_fazer() {
    let pki = issue();
    let port = serve_once(&pki, "{}").await;

    // Este é o BRES-144 exatamente como o baker o encontrou: certificado
    // próprio, nenhuma CA configurada, e as raízes embutidas não o conhecem.
    let error = taps_lib::signer::call(
        &format!("https://127.0.0.1:{port}"),
        None,
        "GET",
        "/keys/tz1fakefakefakefakefakefakefakcRHqXV",
        None,
    )
    .await
    .expect_err("sem CA importada isto não pode conectar");

    assert!(
        error.contains("Configuração"),
        "o erro tem de dizer onde se resolve, e disse: {error}"
    );
}

#[tokio::test]
async fn a_ca_configurada_substitui_as_raizes_publicas() {
    // Duas PKIs independentes: a CA da primeira não pode validar a folha da
    // segunda. Prova que a raiz importada é usada de verdade, e não somada a
    // um conjunto que já aceitaria qualquer coisa.
    let servidor = issue();
    let outra = issue();
    let port = serve_once(&servidor, "{}").await;

    let error = taps_lib::signer::call(
        &format!("https://127.0.0.1:{port}"),
        Some(&outra.ca_pem),
        "GET",
        "/keys/tz1fakefakefakefakefakefakefakcRHqXV",
        None,
    )
    .await
    .expect_err("uma CA que não assinou este certificado não pode ser aceita");

    assert!(error.contains("certificado"), "erro: {error}");
}

#[test]
fn um_arquivo_sem_certificado_e_recusado() {
    // `from_pem_bundle` devolve uma lista VAZIA para texto solto, não um erro.
    // Sem a recusa explícita, isso desligaria as raízes embutidas e não poria
    // nenhuma no lugar: nada confiaria em nada, e o baker descobriria no
    // primeiro pagamento.
    let error = taps_lib::signer::build_client(Some("isto não é um PEM"))
        .expect_err("texto solto não é uma CA");
    assert!(
        error.contains("nenhum certificado"),
        "a recusa tem de dizer o que faltou, e disse: {error}"
    );
}

#[test]
fn um_pem_corrompido_e_recusado() {
    let quebrado = "-----BEGIN CERTIFICATE-----\nnão é base64!!!\n-----END CERTIFICATE-----\n";
    let error =
        taps_lib::signer::build_client(Some(quebrado)).expect_err("PEM corrompido não é uma CA");
    assert!(error.contains("PEM"), "erro: {error}");
}

#[test]
fn a_impressao_digital_e_a_mesma_que_o_openssl_mostra() {
    // O baker compara este valor com `openssl x509 -noout -fingerprint -sha256`
    // no host do signer. Por isso o hash é do DER, não do arquivo: hashear o
    // PEM daria um número que nunca bate com o que ele vê do outro lado.
    let pki = issue();
    let dir = std::env::temp_dir().join(format!("taps-ca-{}.crt", std::process::id()));
    std::fs::write(&dir, &pki.ca_pem).expect("escrever a CA");
    let imported = taps_lib::signer::import_tls_ca_from_file(&dir).expect("importar");
    std::fs::remove_file(&dir).ok();

    assert_eq!(imported.certificates, 1);
    let der = decode_pem_blocks(&pki.ca_pem, "CERTIFICATE").remove(0);
    let esperado: Vec<String> = <sha2::Sha256 as sha2::Digest>::digest(&der)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(imported.sha256, esperado.join(":"));
}

#[test]
fn ninguem_desligou_a_verificacao_do_certificado() {
    // A saída fácil para o BRES-144 seria `danger_accept_invalid_certs(true)`,
    // e ela é pior que o defeito: o corpo desta requisição são os bytes que
    // movem dinheiro, e um TLS que não verifica nada é o HTTP em claro que a
    // própria `call` recusa na primeira linha. Isto é um portão, não um
    // comentário.
    for arquivo in ["src/signer.rs", "src/http.rs", "src/lib.rs"] {
        let fonte = std::fs::read_to_string(arquivo).expect(arquivo);
        // Comentário é documentação; o portão é sobre código que roda — a
        // própria `build_client` explica por escrito por que essa chamada não
        // existe, e essa frase não pode reprovar o teste.
        let codigo = sem_comentarios(&fonte);
        for proibido in [
            "danger_accept_invalid_certs",
            "danger_accept_invalid_hostnames",
        ] {
            assert!(
                !codigo.contains(proibido),
                "{arquivo} chama {proibido} — o corpo desta requisição são os bytes que \
                 movem dinheiro"
            );
        }
    }
}

/// Tira comentários de linha e de bloco, preservando o resto.
fn sem_comentarios(fonte: &str) -> String {
    let mut saida = String::with_capacity(fonte.len());
    let mut resto = fonte;
    loop {
        let ate_fim_da_linha = |i: usize| resto[i..].find('\n').map_or(resto.len(), |n| i + n);
        let ate_fim_do_bloco = |j: usize| resto[j..].find("*/").map_or(resto.len(), |n| j + n + 2);

        let (inicio, fim) = match (resto.find("//"), resto.find("/*")) {
            (None, None) => {
                saida.push_str(resto);
                return saida;
            }
            (Some(i), None) => (i, ate_fim_da_linha(i)),
            (None, Some(j)) => (j, ate_fim_do_bloco(j)),
            (Some(i), Some(j)) if i < j => (i, ate_fim_da_linha(i)),
            (Some(_), Some(j)) => (j, ate_fim_do_bloco(j)),
        };
        saida.push_str(&resto[..inicio]);
        resto = &resto[fim..];
    }
}

/// O certificado do runbook antigo, fixado e servido (BRES-137).
///
/// Importar não basta e instalar no truststore do sistema também não: o
/// rustls recusa um certificado de autoridade usado como certificado de
/// servidor, venha ele de onde vier. O `curl` aceita — por isso o teste de
/// mesa passava e o pagamento não. Sem este caso, um `openssl req -x509`
/// sozinho volta ao guia sem ninguém notar.
#[tokio::test]
async fn um_certificado_ca_true_e_recusado_com_o_que_fazer() {
    let pki = issue_ca_used_as_leaf();
    let port = serve_once(&pki, "{}").await;

    let error = taps_lib::signer::call(
        &format!("https://127.0.0.1:{port}"),
        Some(&pki.ca_pem),
        "GET",
        "/keys/tz1fakefakefakefakefakefakefakcRHqXV",
        None,
    )
    .await
    .expect_err("um CA:TRUE servido como folha não pode conectar");

    // A mensagem tem de mandar refazer o certificado, não conferir o daemon:
    // o daemon é a única coisa que estava certa.
    assert!(
        error.contains("CA como certificado de servidor") && error.contains("Passo 3"),
        "o erro tem de explicar o que refazer, e disse: {error}"
    );
}
