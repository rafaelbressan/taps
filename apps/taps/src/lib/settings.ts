import { ConfigurationError } from '@tezos-suite/chain';
import type { SqlDatabase } from '@tezos-suite/payout-store-sqlite';

/**
 * A configuração do baker, na tabela `app_settings`.
 *
 * Ela é curta de propósito. O que saiu, e por quê:
 *
 * - **Usuário e senha.** Não há superfície HTTP, então não há a quem
 *   autenticar. O `pass_hash` SHA-512 de uma rodada da versão antiga foi
 *   embora com a categoria inteira.
 * - **`gas_limit`, `storage_limit`, `transaction_fee`, `num_blocks_wait`.**
 *   São constantes de protocolo e estimativa de rede; a regra 4 manda lê-las
 *   da cadeia. Deixá-las configuráveis é como o sistema antigo ficou com
 *   `BLOCKS_PER_CYCLE: 4096` de 2019.
 * - **A chave de pagamento.** Nunca esteve aqui e nunca vai estar.
 *
 * Nada tem valor padrão silencioso. Ler uma chave que ninguém configurou
 * levanta, e a tela mostra o que falta — o contrário de um teto de ciclo que
 * alguém nunca escolheu e que por isso não é teto nenhum.
 */

export interface TapsSettings {
  readonly bakerAddress: string;
  readonly network: string;
  readonly rpcUrl: string;
  readonly tzktApiUrl: string;
  readonly signerUrl: string;
  readonly signerPublicKeyHash: string;
  /** Comissão do baker, exata: numerador e denominador. */
  readonly feeNumerator: bigint;
  readonly feeDenominator: bigint;
  readonly includeBlockFees: boolean;
  /** K da RN-24: o corte é K × custo estimado da transferência. */
  readonly payoutFactorNumerator: bigint;
  readonly payoutFactorDenominator: bigint;
  /** Teto por ciclo, em mutez. Sem ele o motor recusa rodar. */
  readonly cycleCapMutez: bigint;
  /** Quantos ciclos podem estar devendo antes de a fila parar e perguntar. */
  readonly maxOwedCycles: number;
  /** Primeiro ciclo pelo qual esta instalação responde. */
  readonly fromCycle: number;
}

const KEYS: Record<keyof TapsSettings, string> = {
  bakerAddress: 'baker.address',
  network: 'chain.network',
  rpcUrl: 'chain.rpc_url',
  tzktApiUrl: 'chain.tzkt_url',
  signerUrl: 'signer.url',
  signerPublicKeyHash: 'signer.pkh',
  feeNumerator: 'policy.fee_numerator',
  feeDenominator: 'policy.fee_denominator',
  includeBlockFees: 'policy.include_block_fees',
  payoutFactorNumerator: 'policy.payout_factor_numerator',
  payoutFactorDenominator: 'policy.payout_factor_denominator',
  cycleCapMutez: 'policy.cycle_cap_mutez',
  maxOwedCycles: 'policy.max_owed_cycles',
  fromCycle: 'policy.from_cycle',
};

/** O que está preenchido, sem julgar se falta algo. */
export async function readRawSettings(db: SqlDatabase): Promise<Map<string, string>> {
  const rows = await db.query('SELECT key, value FROM app_settings');
  return new Map(rows.map((row) => [String(row.key), String(row.value)]));
}

export async function writeRawSettings(
  db: SqlDatabase,
  values: ReadonlyMap<string, string>,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [key, value] of values) {
      await tx.execute(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, value],
      );
    }
  });
}

export const SETTING_KEYS = KEYS;

export interface MissingSetting {
  readonly field: keyof TapsSettings;
  readonly key: string;
  readonly label: string;
}

const LABELS: Record<keyof TapsSettings, string> = {
  bakerAddress: 'endereço do baker',
  network: 'rede',
  rpcUrl: 'endereço do nó (RPC)',
  tzktApiUrl: 'endereço da TzKT',
  signerUrl: 'endereço do octez-signer',
  signerPublicKeyHash: 'endereço da chave de pagamento no signer',
  feeNumerator: 'comissão (numerador)',
  feeDenominator: 'comissão (denominador)',
  includeBlockFees: 'incluir taxas de bloco',
  payoutFactorNumerator: 'fator de corte K (numerador)',
  payoutFactorDenominator: 'fator de corte K (denominador)',
  cycleCapMutez: 'teto por ciclo',
  maxOwedCycles: 'máximo de ciclos devidos',
  fromCycle: 'primeiro ciclo desta instalação',
};

/** O que ainda falta preencher, na ordem em que a tela pergunta. */
export function missingSettings(raw: ReadonlyMap<string, string>): MissingSetting[] {
  const missing: MissingSetting[] = [];
  for (const field of Object.keys(KEYS) as (keyof TapsSettings)[]) {
    const key = KEYS[field];
    const value = raw.get(key);
    if (value === undefined || value.trim() === '') {
      missing.push({ field, key, label: LABELS[field] });
    }
  }
  return missing;
}

/**
 * A configuração completa, ou uma recusa.
 *
 * Um campo ausente não vira zero, string vazia nem valor de fábrica. É a
 * mesma regra que o motor aplica a segredo, pela mesma razão: um teto por
 * ciclo que ninguém escolheu não protege ninguém, e um endereço de signer
 * ausente vira, na versão errada deste código, uma chave local.
 */
export function parseSettings(raw: ReadonlyMap<string, string>): TapsSettings {
  const missing = missingSettings(raw);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `falta configurar: ${missing.map((entry) => entry.label).join(', ')}`,
    );
  }
  const text = (field: keyof TapsSettings): string => raw.get(KEYS[field])!.trim();
  const integer = (field: keyof TapsSettings): bigint => {
    const value = text(field);
    if (!/^\d+$/.test(value)) {
      throw new ConfigurationError(
        `${LABELS[field]} precisa ser um número inteiro e veio "${value}"`,
      );
    }
    return BigInt(value);
  };

  const settings: TapsSettings = {
    bakerAddress: text('bakerAddress'),
    network: text('network'),
    rpcUrl: text('rpcUrl'),
    tzktApiUrl: text('tzktApiUrl'),
    signerUrl: text('signerUrl'),
    signerPublicKeyHash: text('signerPublicKeyHash'),
    feeNumerator: integer('feeNumerator'),
    feeDenominator: integer('feeDenominator'),
    includeBlockFees: text('includeBlockFees') === 'true',
    payoutFactorNumerator: integer('payoutFactorNumerator'),
    payoutFactorDenominator: integer('payoutFactorDenominator'),
    cycleCapMutez: integer('cycleCapMutez'),
    maxOwedCycles: Number(integer('maxOwedCycles')),
    fromCycle: Number(integer('fromCycle')),
  };

  if (settings.feeDenominator === 0n || settings.payoutFactorDenominator === 0n) {
    throw new ConfigurationError('um denominador não pode ser zero');
  }
  if (settings.feeNumerator > settings.feeDenominator) {
    throw new ConfigurationError('a comissão não pode passar de 100%');
  }
  if (settings.cycleCapMutez <= 0n) {
    throw new ConfigurationError('o teto por ciclo precisa ser maior que zero');
  }
  if (settings.maxOwedCycles <= 0) {
    throw new ConfigurationError('o máximo de ciclos devidos precisa ser maior que zero');
  }
  if (!settings.signerUrl.startsWith('https://')) {
    throw new ConfigurationError(
      'o endereço do octez-signer precisa começar com https:// — em texto claro qualquer ' +
        'um no caminho troca os bytes que o signer vai assinar',
    );
  }
  return settings;
}
