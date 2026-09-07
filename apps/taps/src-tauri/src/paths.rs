//! Caminho de arquivo por **token**, nunca por string vinda da tela.
//!
//! A versão anterior recebia o caminho como parâmetro de comando, e o Tezos
//! Core & Crypto reprovou (BRES-48): `read_legacy_export` lia qualquer arquivo
//! e `inspect_database` abria qualquer banco. O `capabilities/default.json`
//! afirmava que os comandos "não aceitam caminho arbitrário vindo da tela".
//! Aceitavam.
//!
//! Aqui o diálogo nativo é aberto **pelo Rust**. O caminho escolhido fica deste
//! lado e a janela recebe um token opaco, mais o nome do arquivo para mostrar.
//! Um token só vale para o propósito com que foi criado e é consumido no uso —
//! um token de "escolher backup para restaurar" não serve para ler a chave do
//! signer.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Para que serve o caminho escolhido. Um token não muda de propósito.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Purpose {
    /// Arquivo da credencial de cliente do `octez-signer`.
    SignerCredential,
    /// Certificado TLS do host do `octez-signer` (`tls.crt`), que é público.
    SignerCertificate,
    /// Arquivo exportado do banco da versão antiga.
    LegacyExport,
    /// Backup a restaurar.
    BackupToRestore,
    /// Onde salvar um backup novo.
    BackupDestination,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickedPath {
    pub token: String,
    /// Só o nome do arquivo, para a tela mostrar. O caminho fica no Rust.
    pub name: String,
}

#[derive(Default)]
pub struct PathRegistry {
    entries: Mutex<HashMap<String, (Purpose, PathBuf)>>,
}

impl PathRegistry {
    pub fn remember(&self, purpose: Purpose, path: PathBuf) -> Result<PickedPath, String> {
        let token = uuid();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        self.entries
            .lock()
            .map_err(|_| "registro de caminhos corrompido".to_string())?
            .insert(token.clone(), (purpose, path));
        Ok(PickedPath { token, name })
    }

    /// Resolve **sem consumir**, para quem só precisa olhar.
    ///
    /// Conferir um backup faz três consultas antes de restaurar, e as quatro
    /// chamadas carregam o mesmo token. Se olhar gastasse a escolha, a segunda
    /// consulta falharia — e o baker leria "o arquivo não está mais
    /// disponível" tendo acabado de escolhê-lo.
    pub fn peek(&self, purpose: Purpose, token: &str) -> Result<PathBuf, String> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| "registro de caminhos corrompido".to_string())?;
        match entries.get(token) {
            Some((stored, path)) if *stored == purpose => Ok(path.clone()),
            Some(_) => Err("este arquivo foi escolhido para outra coisa".to_string()),
            None => {
                Err("o arquivo escolhido não está mais disponível — escolha de novo".to_string())
            }
        }
    }

    /// Resolve e **consome**. Um token serve uma vez, para um propósito só.
    pub fn take(&self, purpose: Purpose, token: &str) -> Result<PathBuf, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "registro de caminhos corrompido".to_string())?;
        match entries.remove(token) {
            Some((stored, path)) if stored == purpose => Ok(path),
            Some((stored, path)) => {
                // Devolve: o token continua válido para o que ele é.
                entries.insert(token.to_string(), (stored, path));
                Err("este arquivo foi escolhido para outra coisa".to_string())
            }
            None => {
                Err("o arquivo escolhido não está mais disponível — escolha de novo".to_string())
            }
        }
    }
}

/// Identificador opaco. Não precisa ser criptográfico: ele não protege nada
/// sozinho — quem protege é o registro do lado do Rust. Precisa só não colidir.
fn uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{nanos:x}-{seq:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_o_token_do_proposito_certo() {
        let registry = PathRegistry::default();
        let picked = registry
            .remember(Purpose::LegacyExport, PathBuf::from("/tmp/taps-export.sql"))
            .expect("token");
        assert_eq!(picked.name, "taps-export.sql");
        assert_eq!(
            registry.take(Purpose::LegacyExport, &picked.token).unwrap(),
            PathBuf::from("/tmp/taps-export.sql")
        );
    }

    #[test]
    fn recusa_o_token_de_outro_proposito_e_o_mantem_valido() {
        let registry = PathRegistry::default();
        let picked = registry
            .remember(Purpose::LegacyExport, PathBuf::from("/tmp/export.sql"))
            .expect("token");

        assert!(registry
            .take(Purpose::SignerCredential, &picked.token)
            .is_err());
        // Recusar não pode consumir: o usuário não fez nada errado.
        assert!(registry.take(Purpose::LegacyExport, &picked.token).is_ok());
    }

    #[test]
    fn um_token_serve_uma_vez() {
        let registry = PathRegistry::default();
        let picked = registry
            .remember(Purpose::BackupToRestore, PathBuf::from("/tmp/backup.db"))
            .expect("token");
        assert!(registry
            .take(Purpose::BackupToRestore, &picked.token)
            .is_ok());
        assert!(registry
            .take(Purpose::BackupToRestore, &picked.token)
            .is_err());
    }

    #[test]
    fn olhar_nao_gasta_a_escolha() {
        // Conferir um backup faz três consultas antes de restaurar. As quatro
        // chamadas carregam o mesmo token.
        let registry = PathRegistry::default();
        let picked = registry
            .remember(Purpose::BackupToRestore, PathBuf::from("/tmp/backup.db"))
            .expect("token");
        for _ in 0..3 {
            assert!(registry
                .peek(Purpose::BackupToRestore, &picked.token)
                .is_ok());
        }
        assert!(registry
            .take(Purpose::BackupToRestore, &picked.token)
            .is_ok());
        // E depois de restaurar, aí sim acabou.
        assert!(registry
            .peek(Purpose::BackupToRestore, &picked.token)
            .is_err());
    }

    #[test]
    fn olhar_tambem_respeita_o_proposito() {
        let registry = PathRegistry::default();
        let picked = registry
            .remember(Purpose::SignerCredential, PathBuf::from("/tmp/client_keys"))
            .expect("token");
        // Um token de credencial não abre um banco.
        assert!(registry
            .peek(Purpose::BackupToRestore, &picked.token)
            .is_err());
    }

    #[test]
    fn token_inventado_nao_abre_nada() {
        let registry = PathRegistry::default();
        assert!(registry.take(Purpose::LegacyExport, "/etc/shadow").is_err());
    }
}
