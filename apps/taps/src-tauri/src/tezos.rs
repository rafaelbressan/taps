//! Base58check com prefixo Tezos, e o pré-hash BLAKE2b-256.
//!
//! Este módulo existe porque a credencial de cliente do `octez-signer` **não
//! pode atravessar para o JavaScript** — a webview tem, ao mesmo tempo, HTTP
//! para fora e a possibilidade de um script chegar até ela, e um segredo que
//! esteja em memória lá é um segredo exfiltrável. A revisão do Tezos Core &
//! Crypto (BRES-48) reprovou a versão anterior por isso e prescreveu esta:
//! assinar do lado do Rust.
//!
//! O que **não** está aqui, deliberadamente: o layout dos bytes que se assina.
//! Ele continua em `buildAuthenticationPayload`, no `@tezos-suite/payout`, que
//! é a parte difícil e é a parte já revisada. Aqui só há composição de
//! primitivas de crates mantidas — `blake2`, `ed25519-dalek`, `bs58` — na
//! ordem que a SPEC-0001 §5 descreve.
//!
//! O vetor de `test_reproduz_o_vetor_do_octez_client` é o mesmo que fixa a
//! implementação TypeScript (`packages/payout-engine/test/unit/signer.spec.ts`),
//! capturado de um `octez-signer --require-authentication` de verdade. Ed25519
//! é determinístico: as duas implementações produzem exatamente os mesmos
//! bytes, ou uma das duas falha.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use ed25519_dalek::{Signer, SigningKey};
use zeroize::{Zeroize, Zeroizing};

type Blake2b256 = Blake2b<U32>;

/// `edsk` de 32 bytes — a semente.
pub const PREFIX_ED25519_SEED: [u8; 4] = [13, 15, 58, 7];
/// `edsk` de 64 bytes — semente seguida da chave pública.
pub const PREFIX_ED25519_SECRET_KEY: [u8; 4] = [43, 246, 78, 7];
/// `edpk`.
pub const PREFIX_ED25519_PUBLIC_KEY: [u8; 4] = [13, 15, 37, 217];
/// `edsig`.
pub const PREFIX_ED25519_SIGNATURE: [u8; 5] = [9, 245, 205, 134, 18];

const SEED_LEN: usize = 32;
const SECRET_KEY_LEN: usize = 64;

pub fn b58check_encode(prefix: &[u8], payload: &[u8]) -> String {
    let mut bytes = Vec::with_capacity(prefix.len() + payload.len());
    bytes.extend_from_slice(prefix);
    bytes.extend_from_slice(payload);
    let encoded = bs58::encode(&bytes).with_check().into_string();
    bytes.zeroize();
    encoded
}

/// Decodifica e **exige** um dos prefixos dados. Devolve o corpo, sem prefixo.
///
/// A checagem do prefixo não é formalidade: um `edpk` e um `edsk` diferem
/// apenas nele, e aceitar o prefixo errado é aceitar a chave errada.
pub fn b58check_decode(
    value: &str,
    prefixes: &[&[u8]],
) -> Result<(Zeroizing<Vec<u8>>, usize), String> {
    let decoded = Zeroizing::new(
        bs58::decode(value)
            .with_check(None)
            .into_vec()
            .map_err(|_| {
                "não é base58check válido (o dígito de verificação não fecha)".to_string()
            })?,
    );
    for (index, prefix) in prefixes.iter().enumerate() {
        if decoded.starts_with(prefix) {
            return Ok((Zeroizing::new(decoded[prefix.len()..].to_vec()), index));
        }
    }
    Err("o prefixo não é o de uma chave Ed25519 do Tezos".to_string())
}

/// A semente de 32 bytes de um `edsk`, aceitando as duas formas que existem.
///
/// Na forma de 64 bytes, os 32 primeiros são a semente e os 32 seguintes são a
/// chave pública, derivável dela. Guardar só a semente é guardar o segredo
/// inteiro e nada além dele.
pub fn ed25519_seed_from_edsk(value: &str) -> Result<Zeroizing<[u8; SEED_LEN]>, String> {
    let (body, which) = b58check_decode(
        value.trim(),
        &[&PREFIX_ED25519_SEED, &PREFIX_ED25519_SECRET_KEY],
    )?;
    let expected = if which == 0 { SEED_LEN } else { SECRET_KEY_LEN };
    if body.len() != expected {
        return Err(format!(
            "a chave decodifica para {} bytes e a forma declarada pelo prefixo tem {expected}",
            body.len()
        ));
    }
    let mut seed = Zeroizing::new([0u8; SEED_LEN]);
    seed.copy_from_slice(&body[..SEED_LEN]);
    Ok(seed)
}

/// O `edpk` correspondente, para o baker conferir com o que autorizou no signer.
pub fn ed25519_public_key(seed: &[u8; SEED_LEN]) -> String {
    let signing = SigningKey::from_bytes(seed);
    b58check_encode(
        &PREFIX_ED25519_PUBLIC_KEY,
        signing.verifying_key().as_bytes(),
    )
}

/// Assina o pedido de autenticação do `octez-signer`.
///
/// `payload` já vem montado do TypeScript — `0x04 || tag || pkh || dados` — e
/// esse layout continua sendo revisado lá. O que acontece aqui é a parte que
/// não pode acontecer numa webview:
///
/// 1. **BLAKE2b-256 primeiro.** `Signature.check` do lado do signer faz o mesmo
///    hash antes de verificar. Assinar o payload cru falha com o layout
///    perfeitamente correto — foi o que fez as tentativas anteriores não
///    convergirem.
/// 2. Ed25519 sobre o digest.
/// 3. Base58check com o prefixo `edsig`.
pub fn sign_authentication(seed: &[u8; SEED_LEN], payload: &[u8]) -> String {
    let digest = Blake2b256::digest(payload);
    let signing = SigningKey::from_bytes(seed);
    let signature = signing.sign(&digest);
    b58check_encode(&PREFIX_ED25519_SIGNATURE, &signature.to_bytes())
}

/// Hexadecimal para bytes, sobre **bytes**, nunca sobre índice de `str`.
///
/// A primeira versão fatiava com `&text[i..i + 2]`, e `str` indexa por byte:
/// uma entrada não-ASCII de tamanho par entrava em panic com
/// `not a char boundary` — `hex_decode("aéa")` derrubava o processo. E a
/// entrada vem da janela, por `signer_authenticate`.
///
/// Não era vazamento: a credencial nem chega a ser lida. Era queda, e uma
/// queda é um payout que não acontece. Achado do Tezos Core & Crypto em
/// BRES-48, registrado em BRES-95.
///
/// Percorrer os bytes fecha a classe inteira em vez do caso: qualquer byte que
/// não seja dígito hexadecimal vira erro — inclusive um byte de continuação de
/// UTF-8, que é o que estava causando o panic.
pub fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    let text = value.strip_prefix("0x").unwrap_or(value).as_bytes();
    if text.len() % 2 != 0 {
        return Err("hexadecimal com número ímpar de dígitos".to_string());
    }
    text.chunks_exact(2)
        .map(|pair| Ok(hex_digit(pair[0])? * 16 + hex_digit(pair[1])?))
        .collect()
}

fn hex_digit(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("hexadecimal inválido".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Capturado de um `octez-client` 25.1 falando com um
    /// `octez-signer --require-authentication` de verdade, por um proxy que
    /// registrava. É o MESMO vetor que fixa a implementação TypeScript.
    ///
    /// As duas chaves são de laboratório e não guardam nada.
    const CLIENT_SECRET_KEY: &str = "edsk3W5ouBAVwo65G5fhTTtqAE3fuRx5ifHLiJ2a3HySqkX1YTWAaE";
    const PAYLOAD_HEX: &str = "040100908e18c77adc5aae4ad25e20f8a19ec9fa20ffe803aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SIGNATURE: &str = "edsigtxsHuA6qpJT6FGGHuk5XunrqPkdiQH4MhSumjU1j5x7mzA3Xa4VDpoAW572NSNtYhiWLynyR7ttP7umxRwyvnYMHRf45d7";

    #[test]
    fn reproduz_o_vetor_do_octez_client() {
        let seed = ed25519_seed_from_edsk(CLIENT_SECRET_KEY).expect("semente");
        let payload = hex_decode(PAYLOAD_HEX).expect("payload");
        assert_eq!(sign_authentication(&seed, &payload), SIGNATURE);
    }

    #[test]
    fn sem_o_pre_hash_a_assinatura_e_outra() {
        // A armadilha que o BRES-74 fechou: o layout sozinho não basta, e
        // assinar cru falha em silêncio no signer, não aqui.
        let seed = ed25519_seed_from_edsk(CLIENT_SECRET_KEY).expect("semente");
        let payload = hex_decode(PAYLOAD_HEX).expect("payload");
        let signing = SigningKey::from_bytes(&seed);
        let raw = b58check_encode(
            &PREFIX_ED25519_SIGNATURE,
            &signing.sign(&payload).to_bytes(),
        );
        assert_ne!(raw, SIGNATURE);
    }

    #[test]
    fn deriva_a_chave_publica_que_o_signer_autoriza() {
        let seed = ed25519_seed_from_edsk(CLIENT_SECRET_KEY).expect("semente");
        let edpk = ed25519_public_key(&seed);
        assert!(edpk.starts_with("edpk"), "veio {edpk}");
        // Ida e volta: o edpk decodifica para 32 bytes sob o prefixo certo.
        let (body, _) = b58check_decode(&edpk, &[&PREFIX_ED25519_PUBLIC_KEY]).expect("edpk");
        assert_eq!(body.len(), 32);
    }

    #[test]
    fn hex_recusa_em_vez_de_derrubar_o_processo() {
        // O reproduzido pelo Tezos Core & Crypto: tamanho PAR em bytes, e o
        // segundo byte cai no meio de um caractere. A versão que fatiava `str`
        // por índice entrava em panic aqui.
        assert!(hex_decode("aéa").is_err());
        assert!(hex_decode("é").is_err());
        assert!(hex_decode("🙂").is_err());
        // E o resto da classe, que a mesma correção fecha.
        assert!(hex_decode("zz").is_err());
        assert!(hex_decode("0f0").is_err());
        assert_eq!(hex_decode("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn hex_le_o_que_e_hexadecimal() {
        assert_eq!(hex_decode("00ff10").unwrap(), vec![0x00, 0xff, 0x10]);
        assert_eq!(hex_decode("0xAbCd").unwrap(), vec![0xab, 0xcd]);
    }

    #[test]
    fn recusa_o_que_nao_e_chave_ed25519() {
        // Um endereço, não uma chave.
        assert!(ed25519_seed_from_edsk("tz1YpNDoR8oURisTtfFgH7pXjCK8eWHJEamL").is_err());
        // Uma chave pública, não uma privada.
        let seed = ed25519_seed_from_edsk(CLIENT_SECRET_KEY).expect("semente");
        assert!(ed25519_seed_from_edsk(&ed25519_public_key(&seed)).is_err());
        // Texto qualquer.
        assert!(ed25519_seed_from_edsk("edsknao-e-uma-chave").is_err());
        // Checksum trocado: o último caractere alterado.
        let mut tampered = CLIENT_SECRET_KEY.to_string();
        tampered.pop();
        tampered.push('F');
        assert!(ed25519_seed_from_edsk(&tampered).is_err());
    }

    #[test]
    fn aceita_a_forma_de_64_bytes_e_chega_na_mesma_semente() {
        let seed = ed25519_seed_from_edsk(CLIENT_SECRET_KEY).expect("semente");
        let signing = SigningKey::from_bytes(&seed);
        let mut full = Vec::with_capacity(64);
        full.extend_from_slice(&seed[..]);
        full.extend_from_slice(signing.verifying_key().as_bytes());
        let long_form = b58check_encode(&PREFIX_ED25519_SECRET_KEY, &full);

        let again = ed25519_seed_from_edsk(&long_form).expect("forma longa");
        assert_eq!(&seed[..], &again[..]);
    }
}
