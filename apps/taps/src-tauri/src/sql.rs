//! O banco do TAPS, do lado que o JavaScript não atravessa.
//!
//! O Rust é dono do arquivo, da conexão e da transação. O TypeScript fala com
//! ele por estes comandos e implementa, do outro lado, exatamente o mesmo port
//! `SqlDatabase` que o `@tezos-suite/payout-store-sqlite` usa no Node — é o que
//! permite o mesmo `SqlitePayoutStore` rodar aqui e nos testes, sem uma segunda
//! implementação das regras de dinheiro.
//!
//! Duas decisões de desenho que não são detalhe:
//!
//! 1. **Valor inteiro atravessa como texto etiquetado.** JSON não tem inteiro
//!    de 64 bits: `JSON.parse` devolve `number`, e um mutez acima de 2^53 volta
//!    errado sem ninguém perceber. Cada valor viaja como `{"t":"i","v":"719997"}`
//!    e volta a ser `bigint` do lado de lá e `INTEGER` do lado de cá.
//! 2. **A transação é do Rust.** `sql_begin` guarda um token e segura o
//!    `Mutex`; enquanto ele existir, nenhuma outra chamada escreve. Sem isso
//!    "a liquidação inteira ou nada" viraria uma promessa que a ponte quebra.

use std::sync::Mutex;

use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Um valor de coluna atravessando a ponte, com o tipo dito em vez de adivinhado.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum SqlValue {
    /// Inteiro de 64 bits, como texto. Dinheiro entra aqui, sempre.
    #[serde(rename = "i")]
    Int(String),
    #[serde(rename = "s")]
    Text(String),
    /// Ponto flutuante. Nenhuma coluna de dinheiro usa este caso.
    #[serde(rename = "f")]
    Real(f64),
    #[serde(rename = "n")]
    Null,
}

impl SqlValue {
    fn to_sql(&self) -> Result<Value, String> {
        Ok(match self {
            SqlValue::Int(text) => Value::Integer(
                text.parse::<i64>()
                    .map_err(|_| format!("{text} não é um inteiro de 64 bits"))?,
            ),
            SqlValue::Text(text) => Value::Text(text.clone()),
            SqlValue::Real(value) => Value::Real(*value),
            SqlValue::Null => Value::Null,
        })
    }

    fn from_ref(value: ValueRef<'_>) -> Result<Self, String> {
        Ok(match value {
            ValueRef::Null => SqlValue::Null,
            ValueRef::Integer(number) => SqlValue::Int(number.to_string()),
            ValueRef::Real(number) => SqlValue::Real(number),
            ValueRef::Text(bytes) => SqlValue::Text(
                String::from_utf8(bytes.to_vec()).map_err(|_| "texto não é UTF-8".to_string())?,
            ),
            ValueRef::Blob(_) => {
                return Err("coluna BLOB: o schema do TAPS não tem nenhuma".to_string())
            }
        })
    }
}

pub struct Database {
    connection: Mutex<Connection>,
    /// Token da transação aberta. `None` quando não há nenhuma.
    open_transaction: Mutex<Option<String>>,
}

impl Database {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        // Os mesmos três pragmas do driver Node, pelas mesmas razões: WAL para
        // sobreviver a uma morte no meio da escrita, `synchronous = FULL`
        // porque um commit perdido aqui é um payout sem hash gravado, e
        // `foreign_keys` porque o SQLite ignora chave estrangeira se ninguém
        // pedir — e é ela que impede apagar histórico financeiro.
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = FULL;
                 PRAGMA foreign_keys = ON;",
            )
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
            open_transaction: Mutex::new(None),
        })
    }

    fn guard(&self, token: Option<&str>) -> Result<(), String> {
        let open = self
            .open_transaction
            .lock()
            .map_err(|_| "estado da transação corrompido".to_string())?;
        match (open.as_deref(), token) {
            (None, None) => Ok(()),
            (Some(current), Some(given)) if current == given => Ok(()),
            (Some(_), _) => Err(
                "há uma transação aberta nesta conexão; a chamada teria escrito fora dela"
                    .to_string(),
            ),
            (None, Some(_)) => Err("a transação já foi encerrada".to_string()),
        }
    }

    pub fn query(
        &self,
        token: Option<&str>,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<Vec<Vec<(String, SqlValue)>>, String> {
        self.guard(token)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "conexão indisponível".to_string())?;
        let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
        let columns: Vec<String> = statement
            .column_names()
            .iter()
            .map(|c| c.to_string())
            .collect();
        let bound: Vec<Value> = params
            .iter()
            .map(SqlValue::to_sql)
            .collect::<Result<_, _>>()?;

        let mut rows = statement
            .query(rusqlite::params_from_iter(bound))
            .map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let mut record = Vec::with_capacity(columns.len());
            for (index, name) in columns.iter().enumerate() {
                let value = row.get_ref(index).map_err(|error| error.to_string())?;
                record.push((name.clone(), SqlValue::from_ref(value)?));
            }
            out.push(record);
        }
        Ok(out)
    }

    pub fn execute(
        &self,
        token: Option<&str>,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<(), String> {
        self.guard(token)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "conexão indisponível".to_string())?;
        let bound: Vec<Value> = params
            .iter()
            .map(SqlValue::to_sql)
            .collect::<Result<_, _>>()?;
        connection
            .execute(sql, rusqlite::params_from_iter(bound))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn begin(&self, token: String) -> Result<(), String> {
        let mut open = self
            .open_transaction
            .lock()
            .map_err(|_| "estado da transação corrompido".to_string())?;
        if open.is_some() {
            return Err(
                "já existe uma transação aberta — aninhar transformaria um rollback em \
                 escrita parcial"
                    .to_string(),
            );
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "conexão indisponível".to_string())?;
        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        *open = Some(token);
        Ok(())
    }

    pub fn finish(&self, token: &str, commit: bool) -> Result<(), String> {
        let mut open = self
            .open_transaction
            .lock()
            .map_err(|_| "estado da transação corrompido".to_string())?;
        match open.as_deref() {
            Some(current) if current == token => {}
            Some(_) => return Err("este token não é o da transação aberta".to_string()),
            None => return Err("não há transação aberta".to_string()),
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "conexão indisponível".to_string())?;
        let result = connection
            .execute_batch(if commit { "COMMIT" } else { "ROLLBACK" })
            .map_err(|error| error.to_string());
        // O token some mesmo se o COMMIT falhar: deixá-lo travaria o banco para
        // sempre, e o SQLite já desfez a transação nesse caso.
        *open = None;
        result
    }

    /// Cópia consistente do banco aberto, para o botão de backup.
    pub fn vacuum_into(&self, destination: &std::path::Path) -> Result<(), String> {
        self.guard(None)?;
        if destination.exists() {
            return Err(format!(
                "já existe um arquivo em {} — o backup não sobrescreve nada",
                destination.display()
            ));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "conexão indisponível".to_string())?;
        connection
            .execute(
                "VACUUM INTO ?1",
                [destination.to_string_lossy().to_string()],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}
