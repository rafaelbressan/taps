//! Casca do TAPS desktop.
//!
//! O TAPS deixou de ser um serviço de nuvem multi-tenant e voltou a ser o que o
//! README original já dizia: "We will use Lucee only for localhost (not
//! Internet)". Não há servidor HTTP, não há login, não há CORS e não há rate
//! limit — some a categoria inteira, e com ela os piores achados da análise.
//!
//! O que o Rust é dono, aqui — e a lista cresceu depois da revisão do Tezos
//! Core & Crypto em BRES-48, que reprovou uma fronteira que não era fronteira:
//!
//! - **O banco.** Arquivo, conexão e transação (`sql`).
//! - **O relógio do agendador.** O tique nasce aqui e não num `setInterval` da
//!   webview: janela escondida faz o WebKit e o WebView2 estrangularem timer, e
//!   um payout que só acontece com a janela aberta não é agendador.
//! - **A credencial de cliente do signer e a assinatura de autenticação**
//!   (`signer`, `tezos`). Ela **não atravessa** para o JavaScript.
//! - **Todo HTTP para fora** (`http`, `signer::call`), contra os endereços que
//!   estão na configuração. A janela não escolhe destino, e por isso a CSP
//!   pode ficar em `connect-src 'self'`.
//! - **Todo caminho de arquivo** (`paths`), por token do diálogo nativo. A
//!   janela não escolhe arquivo.
//!
//! O que o TypeScript é dono: o motor de payout do estágio 4, inteiro e sem um
//! ramo só para desktop, e o layout dos bytes de autenticação — a parte que já
//! foi revisada em BRES-74 e que não há razão para reescrever aqui.

mod http;
mod paths;
mod signer;
mod sql;
mod tezos;

use std::path::PathBuf;
use std::sync::Mutex;

use paths::{PathRegistry, PickedPath, Purpose};
use serde::Serialize;
use sql::{Database, SqlValue};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// Quanto tempo entre dois tiques do agendador.
///
/// O tique só acorda o TypeScript; quem decide se já é hora de rodar é o
/// `PayoutScheduler`, que conhece o intervalo e o back-off. Um minuto é
/// deliberadamente curto em relação a um ciclo Tezos (~24 h em mainnet): o
/// custo de acordar é uma consulta, e o custo de acordar tarde é um ciclo pago
/// mais tarde do que precisava.
const TICK_SECONDS: u64 = 60;

pub struct AppState {
    database: Mutex<Option<Database>>,
    path: PathBuf,
    picked: PathRegistry,
}

impl AppState {
    fn with_db<T>(&self, body: impl FnOnce(&Database) -> Result<T, String>) -> Result<T, String> {
        let guard = self
            .database
            .lock()
            .map_err(|_| "banco indisponível".to_string())?;
        match guard.as_ref() {
            Some(database) => body(database),
            None => Err("o banco está fechado — reinicie o TAPS".to_string()),
        }
    }

    /// Um valor de `app_settings`, lido deste lado.
    ///
    /// É o que permite os comandos de rede não aceitarem endereço vindo da
    /// tela: o endereço do signer, do nó e da TzKT são lidos aqui, do mesmo
    /// banco que a tela escreve mas que o Rust é dono.
    fn setting(&self, key: &str) -> Result<Option<String>, String> {
        let rows = self.with_db(|database| {
            database.query(
                None,
                "SELECT value FROM app_settings WHERE key = ?1",
                &[SqlValue::Text(key.to_string())],
            )
        })?;
        Ok(rows.first().and_then(|row| {
            row.iter()
                .find_map(|(name, value)| match (name.as_str(), value) {
                    ("value", SqlValue::Text(text)) if !text.trim().is_empty() => {
                        Some(text.trim().to_string())
                    }
                    _ => None,
                })
        }))
    }

    /// Escreve um valor de `app_settings` **deste lado**.
    ///
    /// O certificado do signer entra por aqui e não pelo `writeRawSettings` da
    /// tela: quem valida o PEM é o Rust, e um valor validado que a janela
    /// pudesse reescrever depois não estaria validado.
    fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.with_db(|database| {
            database.execute(
                None,
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                &[
                    SqlValue::Text(key.to_string()),
                    SqlValue::Text(value.to_string()),
                ],
            )
        })
    }

    fn delete_setting(&self, key: &str) -> Result<(), String> {
        self.with_db(|database| {
            database.execute(
                None,
                "DELETE FROM app_settings WHERE key = ?1",
                &[SqlValue::Text(key.to_string())],
            )
        })
    }

    fn require_setting(&self, key: &str, why: &str) -> Result<String, String> {
        self.setting(key)?
            .ok_or_else(|| format!("falta configurar {why} — abra Configuração"))
    }

    /// Os dois endereços com que este aplicativo pode falar. Nada mais.
    fn chain_origins(&self) -> Result<Vec<String>, String> {
        let mut allowed = Vec::new();
        for key in ["chain.rpc_url", "chain.tzkt_url"] {
            if let Some(value) = self.setting(key)? {
                allowed.push(value);
            }
        }
        Ok(allowed)
    }
}

#[derive(Serialize)]
pub struct AppStatus {
    /// Caminho do banco, para o baker saber o que copiar.
    database_path: String,
    /// `true` quando a credencial de cliente do signer está no cofre do sistema.
    signer_credential_present: bool,
    /// O `edpk` da credencial guardada, para conferir com o signer. Público.
    signer_credential_public_key: Option<String>,
    /// SHA-256 do certificado do signer fixado nesta máquina, se houver.
    ///
    /// `None` significa que o TAPS não fala com signer nenhum: o canal de
    /// assinatura confia num certificado só, e sem ele `signer::call` recusa.
    signer_certificate_fingerprint: Option<String>,
    /// Preenchido quando o cofre do sistema não respondeu. Enquanto isso vale,
    /// `signer_credential_present: false` não quer dizer "não importou": quer
    /// dizer "não deu para perguntar".
    signer_vault_error: Option<String>,
    platform: String,
    version: String,
}

#[tauri::command]
fn app_status(state: tauri::State<'_, AppState>) -> AppStatus {
    let state_of_credential = signer::credential_state();
    let present = matches!(state_of_credential, signer::CredentialState::Present);
    AppStatus {
        signer_certificate_fingerprint: state
            .setting(SIGNER_CA_PEM)
            .ok()
            .flatten()
            .and_then(|pem| signer::fingerprint(&pem).ok()),
        database_path: state.path.to_string_lossy().to_string(),
        signer_credential_present: present,
        signer_credential_public_key: if present {
            signer::credential_public_key().ok()
        } else {
            None
        },
        signer_vault_error: match state_of_credential {
            signer::CredentialState::VaultDown(why) => Some(why),
            _ => None,
        },
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

// ---------------------------------------------------------------- banco

#[tauri::command]
fn sql_query(
    state: tauri::State<'_, AppState>,
    token: Option<String>,
    sql: String,
    params: Vec<SqlValue>,
) -> Result<Vec<Vec<(String, SqlValue)>>, String> {
    state.with_db(|database| database.query(token.as_deref(), &sql, &params))
}

#[tauri::command]
fn sql_execute(
    state: tauri::State<'_, AppState>,
    token: Option<String>,
    sql: String,
    params: Vec<SqlValue>,
) -> Result<(), String> {
    state.with_db(|database| database.execute(token.as_deref(), &sql, &params))
}

#[tauri::command]
fn sql_begin(state: tauri::State<'_, AppState>, token: String) -> Result<(), String> {
    state.with_db(|database| database.begin(token.clone()))
}

#[tauri::command]
fn sql_commit(state: tauri::State<'_, AppState>, token: String) -> Result<(), String> {
    state.with_db(|database| database.finish(&token, true))
}

#[tauri::command]
fn sql_rollback(state: tauri::State<'_, AppState>, token: String) -> Result<(), String> {
    state.with_db(|database| database.finish(&token, false))
}

// ---------------------------------------------------------------- arquivos

/// Abre o diálogo nativo e guarda o caminho deste lado, devolvendo um token.
///
/// O diálogo é aberto pelo Rust de propósito. Com o plugin chamado da tela, o
/// caminho voltaria como string para o JavaScript e todo comando que o
/// recebesse voltaria a aceitar caminho arbitrário.
#[tauri::command]
async fn pick_file(
    app: tauri::AppHandle,
    purpose: Purpose,
    title: String,
) -> Result<Option<PickedPath>, String> {
    let chosen = app.dialog().file().set_title(&title).blocking_pick_file();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|error| format!("caminho inválido: {error}"))?;
    let state = app.state::<AppState>();
    state.picked.remember(purpose, path).map(Some)
}

#[tauri::command]
async fn pick_save_path(
    app: tauri::AppHandle,
    purpose: Purpose,
    title: String,
    suggested: String,
) -> Result<Option<PickedPath>, String> {
    let chosen = app
        .dialog()
        .file()
        .set_title(&title)
        .set_file_name(&suggested)
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|error| format!("caminho inválido: {error}"))?;
    let state = app.state::<AppState>();
    state.picked.remember(purpose, path).map(Some)
}

// ---------------------------------------------------------------- signer

#[tauri::command]
fn signer_import_credential(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<signer::ImportedCredential, String> {
    let path = state.picked.take(Purpose::SignerCredential, &token)?;
    signer::import_credential_from_file(&path)
}

#[tauri::command]
fn signer_forget_credential() -> Result<(), String> {
    signer::forget_credential()
}

/// Onde mora o certificado que este TAPS aceita do signer.
///
/// No banco, e não no cofre do sistema: é certificado, não segredo. Ficar no
/// banco é o que faz o backup levá-lo junto — restaurar noutra máquina não
/// deve exigir voltar ao host do signer buscar um arquivo público.
const SIGNER_CA_PEM: &str = "signer.tls_ca_pem";

/// Importa o certificado TLS do host do signer.
///
/// O que volta para a tela é a impressão digital, para o baker conferir com
/// `openssl x509 -noout -fingerprint -sha256 -in tls.crt` no host do signer.
/// É a única checagem que o TLS não faz por ele: o TLS confirma que o servidor
/// tem a chave do certificado fixado, não que o certificado fixado é o certo.
#[tauri::command]
fn signer_import_certificate(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<signer::ImportedCertificate, String> {
    let path = state.picked.take(Purpose::SignerCertificate, &token)?;
    let imported = signer::read_certificate_from_file(&path)?;
    state.set_setting(SIGNER_CA_PEM, &imported.pem)?;
    Ok(imported)
}

#[tauri::command]
fn signer_forget_certificate(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.delete_setting(SIGNER_CA_PEM)
}

/// Assina o pedido de autenticação do signer.
///
/// Substitui o antigo `signer_reveal_credential`, que entregava o segredo à
/// webview. A janela manda o layout montado e recebe uma assinatura; a
/// credencial não sai daqui.
#[tauri::command]
fn signer_authenticate(payload_hex: String) -> Result<String, String> {
    signer::authenticate(&payload_hex)
}

#[tauri::command]
async fn signer_call(
    state: tauri::State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<signer::SignerResponse, String> {
    let base = state.require_setting("signer.url", "o endereço do octez-signer")?;
    // Lido deste lado, como o endereço: a janela não escolhe em quem confiar.
    let ca_pem = state.setting(SIGNER_CA_PEM)?;
    signer::call(&base, ca_pem.as_deref(), &method, &path, body).await
}

// ---------------------------------------------------------------- cadeia

#[tauri::command]
async fn chain_request(
    state: tauri::State<'_, AppState>,
    url: String,
    method: String,
    body: Option<String>,
) -> Result<http::HttpReply, String> {
    let allowed = state.chain_origins()?;
    http::request(&url, &method, body, &allowed).await
}

// ---------------------------------------------------------------- backup

#[derive(Serialize)]
pub struct BackupSummary {
    name: String,
    bytes: u64,
}

#[tauri::command]
fn backup_into(state: tauri::State<'_, AppState>, token: String) -> Result<BackupSummary, String> {
    let destination = state.picked.take(Purpose::BackupDestination, &token)?;
    state.with_db(|database| database.vacuum_into(&destination))?;
    let bytes = std::fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    Ok(BackupSummary {
        name: destination
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        bytes,
    })
}

#[derive(Serialize)]
pub struct RestoreSummary {
    replaced_copied_to: String,
}

/// Põe um backup no lugar do banco atual.
///
/// A conferência de que o arquivo é mesmo um backup do TAPS acontece do lado
/// do TypeScript, que abre o candidato por `inspect_database` antes de chamar
/// aqui — com o **mesmo token**, que só é consumido nesta chamada. O que este
/// comando garante é o resto: a conexão é fechada antes da troca, o banco
/// substituído é renomeado e não apagado, e o WAL do banco antigo vai junto —
/// deixá-lo para trás faria o SQLite reproduzi-lo por cima do backup.
#[tauri::command]
fn restore_backup(
    state: tauri::State<'_, AppState>,
    token: String,
    stamp: String,
) -> Result<RestoreSummary, String> {
    let candidate = state.picked.take(Purpose::BackupToRestore, &token)?;
    if !candidate.exists() {
        return Err("o arquivo escolhido não está mais lá".to_string());
    }

    let mut guard = state
        .database
        .lock()
        .map_err(|_| "banco indisponível".to_string())?;
    // Fecha a conexão. A partir daqui o arquivo é só um arquivo.
    *guard = None;

    let replaced = with_suffix(&state.path, &format!(".substituido-{stamp}"));
    if state.path.exists() {
        std::fs::rename(&state.path, &replaced).map_err(|error| error.to_string())?;
        for suffix in ["-wal", "-shm"] {
            let from = with_suffix(&state.path, suffix);
            if from.exists() {
                let _ = std::fs::rename(&from, with_suffix(&replaced, suffix));
            }
        }
    }
    std::fs::copy(&candidate, &state.path).map_err(|error| error.to_string())?;

    *guard = Some(Database::open(&state.path)?);
    Ok(RestoreSummary {
        replaced_copied_to: replaced.to_string_lossy().to_string(),
    })
}

/// Abre o candidato a backup só para leitura, **sem consumir o token**.
///
/// Conferir um backup são três consultas, e restaurar vem logo depois com o
/// mesmo token — por isso `peek` e não `take`.
///
/// O `sql` vem da tela, e isso é aceitável aqui e em nenhum outro lugar: o
/// arquivo é o que o baker escolheu, a conexão é descartada ao fim da chamada,
/// e o banco vivo não é tocado. O que a tela **não** escolhe é o arquivo.
#[tauri::command]
fn inspect_database(
    state: tauri::State<'_, AppState>,
    token: String,
    sql: String,
) -> Result<Vec<Vec<(String, SqlValue)>>, String> {
    let path = state.picked.peek(Purpose::BackupToRestore, &token)?;
    let database = Database::open(&path)?;
    database.query(None, &sql, &[])
}

/// Lê o arquivo exportado do banco antigo. O que fazer com ele é do TypeScript.
#[tauri::command]
fn read_legacy_export(state: tauri::State<'_, AppState>, token: String) -> Result<String, String> {
    let path = state.picked.take(Purpose::LegacyExport, &token)?;
    std::fs::read_to_string(&path).map_err(|error| {
        format!(
            "não consegui ler {} ({error}) — confira se o arquivo veio do comando SCRIPT TO do \
             banco antigo",
            path.display()
        )
    })
}

fn with_suffix(path: &std::path::Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("sem diretório de dados do aplicativo: {error}"))?
                .join("taps.db");
            let database = Database::open(&path)?;
            app.manage(AppState {
                database: Mutex::new(Some(database)),
                path,
                picked: PathRegistry::default(),
            });

            // O relógio do agendador. Um evento, nada mais: quem decide se é
            // hora de pagar é o motor, do outro lado.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_secs(TICK_SECONDS));
                loop {
                    ticker.tick().await;
                    let _ = handle.emit("taps://tick", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            sql_query,
            sql_execute,
            sql_begin,
            sql_commit,
            sql_rollback,
            pick_file,
            pick_save_path,
            signer_import_credential,
            signer_forget_credential,
            signer_import_certificate,
            signer_forget_certificate,
            signer_authenticate,
            signer_call,
            chain_request,
            backup_into,
            restore_backup,
            inspect_database,
            read_legacy_export,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o TAPS");
}
