//! O TLS do canal de assinatura, contra um `octez-signer` de verdade.
//!
//! Este teste existe porque o bug da BRES-137 passou por todos os outros. O
//! repo já provava a autenticação contra o binário real
//! (`payout-engine/test/integration/octez-signer.spec.ts`) — mas **por HTTP em
//! claro**. A perna de TLS, que é a que estava quebrada, não tinha ninguém
//! olhando, e o `curl` do runbook respondia 200 em cima do certificado que o
//! aplicativo recusava.
//!
//! Duas coisas que só o daemon de verdade sabe dizer, e que nenhum servidor de
//! teste genérico prova:
//!
//! - que o certificado gerado pelo comando do `OCTEZ-SIGNER.md` é aceito;
//! - que o certificado gerado pelo comando **anterior** (`CA:TRUE`) não é, e
//!   com qual mensagem.
//!
//! É `#[ignore]` de propósito: precisa de Docker e da imagem do Octez, e o CI
//! do desktop não tem os dois. Para rodar:
//!
//! ```text
//! cargo test --lib -- --ignored --nocapture signer_tls_live
//! ```

#![cfg(test)]

use std::path::Path;
use std::process::Command;

const IMAGE: &str = "tezos/tezos:octez-v25.2";
const CONTAINER: &str = "taps-signer-tls-live-test";
const PORT: u16 = 21733;

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("{program}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} {args:?} falhou: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn docker_available() -> bool {
    run("docker", &["info", "--format", "{{.ServerVersion}}"]).is_ok()
}

/// `octez-signer` com o diretório de dados montado.
fn signer_cli(data: &Path, args: &[&str]) -> Result<String, String> {
    let mount = format!("{}:/data", data.display());
    let mut full = vec![
        "run",
        "--rm",
        "-v",
        &mount,
        "--entrypoint",
        "octez-signer",
        IMAGE,
        "-d",
        "/data",
    ];
    full.extend_from_slice(args);
    run("docker", &full)
}

/// O `[{ "name": …, "value": "unencrypted:…" }]` que o signer escreve.
fn wallet_value(dir: &Path, file: &str, name: &str) -> String {
    let text = std::fs::read_to_string(dir.join(file)).expect("arquivo de carteira");
    // Sem dependência de JSON só para um teste: o formato é fixo e conhecido.
    let key = format!("\"{name}\"");
    let after = text.split(&key).nth(1).expect("entrada da carteira");
    let value = after.split("\"value\":").nth(1).expect("campo value");
    let quoted = value.split('"').nth(1).expect("valor entre aspas");
    quoted.trim_start_matches("unencrypted:").to_string()
}

/// Um certificado como o runbook manda gerar. `ca_false` diz qual runbook.
fn make_certificate(dir: &Path, name: &str, ca_false: bool) -> String {
    let key = dir.join(format!("{name}.key"));
    let crt = dir.join(format!("{name}.crt"));
    let key = key.to_string_lossy().to_string();
    let crt = crt.to_string_lossy().to_string();
    let mut args = vec![
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        &key,
        "-out",
        &crt,
        "-subj",
        "/CN=taps-signer",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:taps-signer",
    ];
    if ca_false {
        args.push("-addext");
        args.push("basicConstraints=critical,CA:FALSE");
    }
    run("openssl", &args).expect("openssl gera o certificado");
    std::fs::read_to_string(&crt).expect("lê o certificado")
}

fn stop_container() {
    let _ = run("docker", &["rm", "-f", CONTAINER]);
}

/// Sobe o signer com um certificado e espera ele aceitar conexão.
fn start_signer(data: &Path, dir: &Path, cert_name: &str) {
    stop_container();
    let data_mount = format!("{}:/data", data.display());
    let crt_mount = format!("{}/{cert_name}.crt:/tls.crt:ro", dir.display());
    let key_mount = format!("{}/{cert_name}.key:/tls.key:ro", dir.display());
    let port = format!("{PORT}:6732");
    run(
        "docker",
        &[
            "run",
            "-d",
            "--name",
            CONTAINER,
            "-p",
            &port,
            "-v",
            &data_mount,
            "-v",
            &crt_mount,
            "-v",
            &key_mount,
            "--entrypoint",
            "octez-signer",
            IMAGE,
            "-d",
            "/data",
            "--require-authentication",
            "launch",
            "https",
            "signer",
            "/tls.crt",
            "/tls.key",
            "--address",
            "0.0.0.0",
            "--port",
            "6732",
            "--magic-bytes",
            "0x03",
        ],
    )
    .expect("sobe o signer");

    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Ok(logs) = run("docker", &["logs", CONTAINER]) {
            if logs.contains("accepting HTTPS requests") {
                return;
            }
        }
        // O `docker logs` do Octez escreve nos dois canais; olha o stderr também.
        let combined = Command::new("docker")
            .args(["logs", CONTAINER])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stderr).to_string())
            .unwrap_or_default();
        if combined.contains("accepting HTTPS requests") {
            return;
        }
    }
    panic!("o signer não subiu a tempo");
}

#[test]
#[ignore = "precisa de Docker e da imagem do Octez"]
fn signer_tls_live() {
    if !docker_available() {
        // Pular em silêncio é como um teste morre sem ninguém notar.
        eprintln!("teste de TLS ao vivo pulado: o Docker não responde nesta máquina");
        return;
    }

    let dir = std::env::temp_dir().join(format!("taps-tls-live-{}", std::process::id()));
    let data = dir.join("data");
    std::fs::create_dir_all(&data).expect("diretório do signer");

    signer_cli(&data, &["gen", "keys", "payout"]).expect("cria a chave de pagamento");
    let payout_pkh = wallet_value(&data, "public_key_hashs", "payout");
    let path = format!("/keys/{payout_pkh}");

    let bom = make_certificate(&dir, "bom", true);
    let ruim = make_certificate(&dir, "ruim", false);
    let base = format!("https://127.0.0.1:{PORT}");

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    // 1. O certificado do runbook ANTIGO (`CA:TRUE`). O `curl` aceita; o
    //    rustls não, e é exatamente o caso que a BRES-137 relatou.
    start_signer(&data, &dir, "ruim");
    let why = runtime
        .block_on(super::call(&base, Some(&ruim), "GET", &path, None))
        .expect_err("um certificado CA:TRUE não pode ser aceito");
    assert!(why.contains("CA:FALSE"), "{why}");

    // 2. O certificado do runbook CORRIGIDO. O signer responde de verdade.
    start_signer(&data, &dir, "bom");
    let response = runtime
        .block_on(super::call(&base, Some(&bom), "GET", &path, None))
        .expect("o signer tem que responder");
    assert_eq!(response.status, 200, "{}", response.body);
    assert!(response.body.contains("edpk"), "{}", response.body);

    // 3. Fixar o certificado errado — a rotação feita pela metade.
    let why = runtime
        .block_on(super::call(&base, Some(&ruim), "GET", &path, None))
        .expect_err("o certificado antigo não vale depois da troca");
    assert!(why.contains("não é o que está importado aqui"), "{why}");

    stop_container();
    let _ = std::fs::remove_dir_all(&dir);
}
