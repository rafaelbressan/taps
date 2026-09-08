import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pickFile } from '../lib/pick';
import type { Ready } from '../App';
import { describe } from '../App';
import { SETTING_KEYS, readRawSettings, writeRawSettings } from '../lib/settings';
import { Fault } from '../ui/Fault';

/**
 * Configuração.
 *
 * O que está aqui, e o que deliberadamente não está:
 *
 * - **Não há usuário nem senha.** Não existe superfície HTTP, então não há a
 *   quem autenticar.
 * - **Não há limite de gas, de storage nem taxa fixa.** São constantes de
 *   protocolo e estimativa de rede; lê-las da cadeia é regra, e deixá-las
 *   configuráveis foi como o sistema antigo ficou parado em 2019.
 * - **Não há chave de pagamento.** Ela vive no host do `octez-signer`.
 * - **Nada tem valor padrão.** Um campo em branco deixa o aplicativo parado com
 *   a frase do que falta; um teto por ciclo que ninguém escolheu não é teto.
 */

interface Field {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly placeholder?: string;
}

const FIELDS: readonly Field[] = [
  {
    key: SETTING_KEYS.bakerAddress,
    label: 'Endereço do baker',
    hint: 'O endereço cujas recompensas este TAPS distribui.',
    placeholder: 'tz1…',
  },
  {
    key: SETTING_KEYS.network,
    label: 'Rede',
    hint: 'mainnet move dinheiro de verdade. Comece numa rede de teste.',
    placeholder: 'ghostnet',
  },
  {
    key: SETTING_KEYS.rpcUrl,
    label: 'Endereço do nó (RPC)',
    hint: 'O nó que estima, pré-aplica e injeta a operação.',
    placeholder: 'https://…',
  },
  {
    key: SETTING_KEYS.tzktApiUrl,
    label: 'Endereço da TzKT',
    hint: 'De onde vêm o ciclo, o split de recompensa e o estado da operação.',
    placeholder: 'https://api.ghostnet.tzkt.io',
  },
  {
    key: SETTING_KEYS.signerUrl,
    label: 'Endereço do octez-signer',
    hint: 'Precisa ser https://. Em texto claro, qualquer um no caminho troca os bytes que o signer vai assinar.',
    placeholder: 'https://192.168.1.10:6732',
  },
  {
    key: SETTING_KEYS.signerPublicKeyHash,
    label: 'Endereço da chave de pagamento',
    hint: 'O endereço, no signer, de onde o dinheiro sai. A chave em si nunca chega aqui.',
    placeholder: 'tz1…',
  },
  {
    key: SETTING_KEYS.feeNumerator,
    label: 'Comissão — numerador',
    hint: 'Comissão exata como fração. 5% é 5 sobre 100.',
    placeholder: '5',
  },
  {
    key: SETTING_KEYS.feeDenominator,
    label: 'Comissão — denominador',
    hint: 'Fração, nunca decimal: 5,25% é 525 sobre 10000.',
    placeholder: '100',
  },
  {
    key: SETTING_KEYS.includeBlockFees,
    label: 'Incluir taxas de bloco (true/false)',
    hint: 'Se as taxas das operações que você incluiu nos blocos entram no bolo dos delegadores.',
    placeholder: 'true',
  },
  {
    key: SETTING_KEYS.payoutFactorNumerator,
    label: 'Fator de corte K — numerador',
    hint: 'Só entra no lote quem tem a receber ao menos K vezes o custo da transferência.',
    placeholder: '3',
  },
  {
    key: SETTING_KEYS.payoutFactorDenominator,
    label: 'Fator de corte K — denominador',
    hint: 'K = 3/1 significa pagar quando o devido cobre três vezes a taxa.',
    placeholder: '1',
  },
  {
    key: SETTING_KEYS.cycleCapMutez,
    label: 'Teto por ciclo (mutez)',
    hint: 'Acima disso o motor recusa e chama você. 1 ꜩ = 1000000 mutez.',
    placeholder: '1000000000',
  },
  {
    key: SETTING_KEYS.maxOwedCycles,
    label: 'Máximo de ciclos devidos',
    hint: 'Acima disso a fila para e pergunta, em vez de pagar uma semana de uma vez.',
    placeholder: '3',
  },
  {
    key: SETTING_KEYS.fromCycle,
    label: 'Primeiro ciclo desta instalação',
    hint: 'Sem ele, "todo ciclo não pago" alcançaria o começo da cadeia.',
    placeholder: '900',
  },
];

export function Settings({ ready, onSaved }: { ready: Ready; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [credentialPresent, setCredentialPresent] = useState(
    ready.status.signer_credential_present,
  );
  const [credentialPublicKey, setCredentialPublicKey] = useState(
    ready.status.signer_credential_public_key,
  );
  const [tlsCaPresent, setTlsCaPresent] = useState(ready.status.signer_tls_ca_present);
  const [tlsCaFingerprint, setTlsCaFingerprint] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const raw = await readRawSettings(ready.db);
      setValues(Object.fromEntries(raw));
    })().catch((caught) => setError(describe(caught)));
  }, [ready]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await writeRawSettings(ready.db, new Map(Object.entries(values)));
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setSaving(false);
    }
  }

  /**
   * O segredo entra por arquivo, e a tela nem sabe onde o arquivo está.
   *
   * O requisito 9 da ADR-0001 proíbe coletar segredo por `<input>` de HTML: a
   * parede que protege a chave não vale nada se o que a abre nasce do lado
   * errado dela. Aqui o diálogo é aberto pelo Rust, que guarda o caminho e
   * devolve um token; o conteúdo vai do disco para o cofre do sistema sem
   * passar por JavaScript nenhum.
   *
   * O que volta para a tela é o `edpk` derivado — público — para o baker
   * conferir contra o que ele autorizou no signer.
   */
  async function importCredential() {
    setError(null);
    try {
      const chosen = await pickFile(
        'signer-credential',
        'Arquivo da credencial de cliente do octez-signer',
      );
      if (!chosen) return;
      const imported = await invoke<{ public_key: string }>('signer_import_credential', {
        token: chosen.token,
      });
      setCredentialPresent(true);
      setCredentialPublicKey(imported.public_key);
      onSaved();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  /**
   * O certificado da CA do signer (BRES-144).
   *
   * Ele é público — não é segredo, e por isso vai para o banco e não para o
   * cofre. Mesmo assim entra por arquivo escolhido pelo Rust: quem decide a
   * raiz de confiança da conexão que pede assinatura decide de quem esta
   * máquina aceita bytes, e isso não é decisão da janela.
   */
  async function importTlsCa() {
    setError(null);
    try {
      const chosen = await pickFile('signer-tls-ca', 'ca.crt do octez-signer');
      if (!chosen) return;
      const imported = await invoke<{ sha256: string }>('signer_import_tls_ca', {
        token: chosen.token,
      });
      setTlsCaPresent(true);
      setTlsCaFingerprint(imported.sha256);
      onSaved();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function forgetTlsCa() {
    setError(null);
    try {
      await invoke('signer_forget_tls_ca');
      setTlsCaPresent(false);
      setTlsCaFingerprint(null);
      onSaved();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function forgetCredential() {
    setError(null);
    try {
      await invoke('signer_forget_credential');
      setCredentialPresent(false);
      setCredentialPublicKey(null);
      onSaved();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  return (
    <>
      <h1 className="page__title">Configuração</h1>
      <p className="page__lede">
        Nada aqui tem valor de fábrica. Enquanto faltar um campo, o TAPS não paga nada — e a
        tela de início diz o que está faltando.
      </p>

      {error && (
        <Fault what="Não consegui salvar" where="configuração" cost={error} />
      )}
      {saved && <p className="note">Configuração salva.</p>}

      <section className="t-card" style={{ marginBottom: 'var(--s-6)' }}>
        <h2 className="pair__key">Credencial de cliente do octez-signer</h2>
        <p className="note">
          É com ela que este computador prova ao signer quem está pedindo. Ela não é a chave
          que guarda os fundos — essa fica no host do <code>octez-signer</code> —, mas{' '}
          <strong>é capacidade de gasto</strong>: quem a tiver consegue pedir assinatura de
          transferência ao seu signer. Trate-a como uma chave. Fica no cofre de credenciais do
          sistema operacional, não no banco, e por isso não entra no backup.
        </p>
        <div className="pair">
          <span className="pair__key">Estado</span>
          <span className="pair__value">
            {credentialPresent ? 'guardada' : 'ausente'}
          </span>
        </div>
        {credentialPublicKey && (
          <div className="pair">
            <span className="pair__key">Chave pública</span>
            <span className="pair__value t-address" title={credentialPublicKey}>
              {credentialPublicKey}
            </span>
          </div>
        )}
        <p className="note" style={{ marginTop: 'var(--s-3)' }}>
          A chave entra por arquivo, e não digitada aqui: um segredo colado numa página não
          deveria existir. Escolha o arquivo que o <code>octez-signer gen keys</code> deixou —
          ele vai do disco direto para o cofre do sistema, sem passar por esta tela. Depois de
          importado, pode apagar o arquivo.
        </p>
        <p className="note">
          O arquivo precisa ter <strong>uma chave só</strong>. O <code>secret_keys</code> do
          próprio signer tem várias, e uma delas é a de pagamento — o TAPS recusa esse arquivo
          em vez de escolher por você. Depois de importar, compare a chave pública acima com o
          que você autorizou no signer.
        </p>
        <div className="row" style={{ marginTop: 'var(--s-4)' }}>
          <button type="button" className="t-button" onClick={importCredential}>
            Escolher o arquivo da credencial
          </button>
          {credentialPresent && (
            <button type="button" className="t-button t-button--quiet" onClick={forgetCredential}>
              Esquecer
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Certificado do signer</h2>
        <div className="pair">
          <span className="pair__key">Estado</span>
          <span className="pair__value">
            {tlsCaPresent ? 'CA importada' : 'só CAs públicas'}
          </span>
        </div>
        {tlsCaFingerprint && (
          <div className="pair">
            <span className="pair__key">SHA-256</span>
            <span className="pair__value t-address" title={tlsCaFingerprint}>
              {tlsCaFingerprint}
            </span>
          </div>
        )}
        <p className="note" style={{ marginTop: 'var(--s-3)' }}>
          O TAPS só fala com o signer por TLS, e um signer na sua rede não tem certificado de
          autoridade pública. Importe o <code>ca.crt</code> que o Passo 3 do guia do{' '}
          <code>octez-signer</code> gera. Sem ele o TAPS não completa a conexão e nenhum ciclo é
          pago.
        </p>
        <p className="note">
          Depois de importar, confira o SHA-256 acima contra o que{' '}
          <code>openssl x509 -in ca.crt -noout -fingerprint -sha256</code> mostra na máquina do
          signer. A CA importada passa a ser a <strong>única</strong> aceita nesta conexão — as
          públicas saem, porque um signer nunca é um site público.
        </p>
        <div className="row" style={{ marginTop: 'var(--s-4)' }}>
          <button type="button" className="t-button" onClick={importTlsCa}>
            Escolher o ca.crt do signer
          </button>
          {tlsCaPresent && (
            <button type="button" className="t-button t-button--quiet" onClick={forgetTlsCa}>
              Esquecer
            </button>
          )}
        </div>
      </section>

      <div className="grid">
        {FIELDS.map((field) => (
          <label key={field.key} className="t-field">
            <span className="t-field__label">{field.label}</span>
            <input
              className="t-field__input"
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              spellCheck={false}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
            <span className="t-field__hint">{field.hint}</span>
          </label>
        ))}
      </div>

      <div className="row" style={{ marginTop: 'var(--s-6)' }}>
        <button type="button" className="t-button" disabled={saving} onClick={save}>
          {saving ? 'salvando…' : 'Salvar'}
        </button>
      </div>
    </>
  );
}
