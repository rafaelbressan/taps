//! Todo HTTP da cadeia sai por aqui, e só para os dois endereços configurados.
//!
//! Antes, o `fetch` da webview falava direto com o nó e com a TzKT, e a CSP
//! precisava de `connect-src 'self' https:` para isso. Com um segredo em
//! memória do outro lado, essa linha era o caminho de saída — foi um dos
//! motivos da reprovação do Tezos Core & Crypto em BRES-48.
//!
//! Agora a webview não tem para onde falar: a CSP é `connect-src 'self'`, e
//! quem faz a chamada é este módulo, que confere o endereço contra o que está
//! na configuração **do lado do Rust**. A janela pode pedir; ela não pode
//! escolher o destino.
//!
//! A resposta volta com status, corpo e cabeçalhos porque o cliente da TzKT lê
//! `tzkt-level` e `tzkt-known-level` para saber o quanto o indexador está
//! atrasado — jogar cabeçalho fora aqui seria apagar essa checagem sem que
//! ninguém percebesse.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

/// Os cabeçalhos que o cliente da cadeia usa. O resto não atravessa.
const FORWARDED_HEADERS: [&str; 4] = [
    "content-type",
    "tzkt-level",
    "tzkt-known-level",
    "tzkt-synced-at",
];

pub fn assert_allowed(url: &str, allowed: &[String]) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| format!("{url} não é uma URL"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(format!("{} não é um esquema de rede", parsed.scheme()));
    }

    for base in allowed {
        let Ok(base_url) = url::Url::parse(base) else {
            continue;
        };
        // Compara origem, não prefixo de texto: `https://api.tzkt.io.evil.com`
        // começa com `https://api.tzkt.io` e não é o mesmo servidor.
        if base_url.origin() == parsed.origin() {
            return Ok(());
        }
    }

    Err(format!(
        "o TAPS só fala com o nó e com a TzKT que estão na configuração, e {} não é nenhum dos \
         dois. Se o endereço mudou, mude-o em Configuração.",
        parsed.origin().ascii_serialization()
    ))
}

pub async fn request(
    url: &str,
    method: &str,
    body: Option<String>,
    allowed: &[String],
) -> Result<HttpReply, String> {
    assert_allowed(url, allowed)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
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
        other => return Err(format!("método {other} não é usado no caminho da cadeia")),
    };

    let response = request
        .send()
        .await
        .map_err(|error| format!("não consegui falar com {url} ({error})"))?;

    let status = response.status().as_u16();
    let headers = FORWARDED_HEADERS
        .iter()
        .filter_map(|name| {
            response
                .headers()
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|value| ((*name).to_string(), value.to_string()))
        })
        .collect();
    let body = response.text().await.map_err(|error| error.to_string())?;

    Ok(HttpReply {
        status,
        body,
        headers,
    })
}

#[cfg(test)]
mod tests {
    use super::assert_allowed;

    fn allowed() -> Vec<String> {
        vec![
            "https://rpc.ghostnet.teztnets.com".to_string(),
            "https://api.ghostnet.tzkt.io/".to_string(),
        ]
    }

    #[test]
    fn deixa_passar_o_no_e_a_tzkt_configurados() {
        assert!(assert_allowed(
            "https://rpc.ghostnet.teztnets.com/chains/main/blocks/head/header",
            &allowed()
        )
        .is_ok());
        assert!(assert_allowed("https://api.ghostnet.tzkt.io/v1/head", &allowed()).is_ok());
    }

    #[test]
    fn recusa_qualquer_outro_destino() {
        assert!(assert_allowed("https://exfiltra.example/", &allowed()).is_err());
    }

    #[test]
    fn compara_origem_e_nao_prefixo_de_texto() {
        // Passaria numa comparação por `starts_with`, e é um servidor de outra
        // pessoa.
        assert!(assert_allowed(
            "https://api.ghostnet.tzkt.io.evil.example/v1/head",
            &allowed()
        )
        .is_err());
    }

    #[test]
    fn porta_diferente_e_outro_servidor() {
        assert!(assert_allowed("https://api.ghostnet.tzkt.io:8443/v1/head", &allowed()).is_err());
    }

    #[test]
    fn sem_configuracao_nao_passa_nada() {
        assert!(assert_allowed("https://api.ghostnet.tzkt.io/v1/head", &[]).is_err());
    }
}
