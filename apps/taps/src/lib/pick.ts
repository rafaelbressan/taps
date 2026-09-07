import { invoke } from '@tauri-apps/api/core';

/**
 * Escolher um arquivo, sem que a janela saiba onde ele está.
 *
 * O diálogo nativo é aberto **pelo Rust**, que guarda o caminho e devolve um
 * token. A tela recebe o token e o nome do arquivo, para mostrar; o caminho
 * fica do outro lado.
 *
 * A versão anterior usava o plugin de diálogo direto da janela e passava o
 * caminho de volta como string para cada comando. O Tezos Core & Crypto
 * reprovou (BRES-48): com isso, `read_legacy_export` lia qualquer arquivo e
 * `inspect_database` abria qualquer banco — a afirmação de que os comandos
 * "não aceitam caminho arbitrário vindo da tela" era falsa.
 */

/** Para que serve o arquivo. Um token não muda de propósito. */
export type PickPurpose =
  | 'signer-credential'
  | 'signer-certificate'
  | 'legacy-export'
  | 'backup-to-restore'
  | 'backup-destination';

export interface Picked {
  readonly token: string;
  /** Só o nome, para a tela mostrar. */
  readonly name: string;
}

export function pickFile(purpose: PickPurpose, title: string): Promise<Picked | null> {
  return invoke<Picked | null>('pick_file', { purpose, title });
}

export function pickSavePath(
  purpose: PickPurpose,
  title: string,
  suggested: string,
): Promise<Picked | null> {
  return invoke<Picked | null>('pick_save_path', { purpose, title, suggested });
}
