//! Casca do TAPS desktop.
//!
//! O TAPS deixou de ser um serviço de nuvem multi-tenant e voltou a ser o que o
//! README original já dizia: "We will use Lucee only for localhost (not
//! Internet)". Não há servidor HTTP, não há login, não há CORS e não há rate
//! limit — some a categoria inteira, e com ela os piores achados da análise.
//!
//! O que o Rust é dono, aqui:
//!
//! - **O banco.** Arquivo, conexão e transação (`sql`).
//! - **O relógio do agendador.** O tique nasce aqui e não num `setInterval` da
//!   webview: janela escondida faz o WebKit e o WebView2 estrangularem timer, e
//!   um payout que só acontece com a janela aberta não é agendador.
//! - **A credencial de cliente do signer** e o HTTP até ele (`signer`).
//! - **Backup e restauração**, inclusive a troca do arquivo, que precisa da
//!   conexão fechada.
//!
//! O que o TypeScript é dono: o motor de payout do estágio 4, inteiro e sem um
//! ramo só para desktop.

mod signer;
mod sql;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sql::{Database, SqlValue};
use tauri::{Emitter, Manager};

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
}

#[derive(Serialize)]
pub struct AppStatus {
    /// Caminho do banco, para o baker saber o que copiar.
    database_path: String,
    /// `true` quando a credencial de cliente do signer está no cofre do sistema.
    signer_credential_present: bool,
    platform: String,
    version: String,
}

#[tauri::command]
fn app_status(state: tauri::State<'_, AppState>) -> AppStatus {
    AppStatus {
        database_path: state.path.to_string_lossy().to_string(),
        signer_credential_present: signer::credential_present(),
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

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

#[tauri::command]
fn signer_import_credential(path: String) -> Result<(), String> {
    signer::import_credential_from_file(&path)
}

#[tauri::command]
fn signer_forget_credential() -> Result<(), String> {
    signer::forget_credential()
}

#[tauri::command]
fn signer_reveal_credential() -> Result<String, String> {
    signer::reveal_credential()
}

#[tauri::command]
async fn signer_call(
    url: String,
    method: String,
    body: Option<String>,
) -> Result<signer::SignerResponse, String> {
    signer::call(&url, &method, body).await
}

#[derive(Serialize)]
pub struct BackupSummary {
    path: String,
    bytes: u64,
}

#[tauri::command]
fn backup_into(state: tauri::State<'_, AppState>, path: String) -> Result<BackupSummary, String> {
    let destination = PathBuf::from(&path);
    state.with_db(|database| database.vacuum_into(&destination))?;
    let bytes = std::fs::metadata(&destination)
        .map_err(|error| error.to_string())?
        .len();
    Ok(BackupSummary { path, bytes })
}

#[derive(Serialize)]
pub struct RestoreSummary {
    replaced_copied_to: String,
}

/// Põe um backup no lugar do banco atual.
///
/// A conferência de que o arquivo é mesmo um backup do TAPS acontece do lado
/// do TypeScript, que abre o candidato por este mesmo comando antes de chamar
/// aqui. O que **este** comando garante é o resto: a conexão é fechada antes da
/// troca, o banco substituído é renomeado e não apagado, e o WAL do banco
/// antigo vai junto — deixá-lo para trás faria o SQLite reproduzi-lo por cima
/// do backup restaurado.
#[tauri::command]
fn restore_backup(
    state: tauri::State<'_, AppState>,
    path: String,
    stamp: String,
) -> Result<RestoreSummary, String> {
    let candidate = PathBuf::from(&path);
    if !candidate.exists() {
        return Err(format!("não achei o arquivo {path}"));
    }

    let mut guard = state
        .database
        .lock()
        .map_err(|_| "banco indisponível".to_string())?;
    // Fecha a conexão. A partir daqui o arquivo é só um arquivo.
    *guard = None;

    let replaced = state.path.with_extension(format!("substituido-{stamp}"));
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

/// Abre outro arquivo de banco só para leitura, para conferir um backup.
#[tauri::command]
fn inspect_database(path: String, sql: String) -> Result<Vec<Vec<(String, SqlValue)>>, String> {
    let database = Database::open(&PathBuf::from(path))?;
    database.query(None, &sql, &[])
}

#[derive(Deserialize)]
pub struct ImportRequest {
    path: String,
}

/// Lê o arquivo exportado do banco antigo. O que fazer com ele é do TypeScript.
#[tauri::command]
fn read_legacy_export(request: ImportRequest) -> Result<String, String> {
    std::fs::read_to_string(&request.path).map_err(|error| {
        format!(
            "não consegui ler {} ({error}) — confira se o caminho está certo e se o arquivo \
             veio do comando SCRIPT TO do banco antigo",
            request.path
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
            signer_import_credential,
            signer_forget_credential,
            signer_reveal_credential,
            signer_call,
            backup_into,
            restore_backup,
            inspect_database,
            read_legacy_export,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o TAPS");
}
