import { MIGRATIONS } from './migrations';
import { SqlDriverError, type SqlDatabase } from './db';

/**
 * Tirar uma cópia consistente do banco enquanto o aplicativo está aberto.
 *
 * A instrução antiga de atualização é o padrão que isto precisa bater. Ela diz,
 * literalmente: "(Always!) Write down in a piece of paper your Taps Native
 * Wallet mnemonic words and passphrase", e depois `git fetch --all` e
 * `git reset --hard origin/master`. Um procedimento de backup que começa num
 * papel e termina num comando destrutivo não é um procedimento de backup.
 *
 * `VACUUM INTO` escreve um banco novo e inteiro a partir da visão da transação
 * corrente. Copiar o arquivo com o aplicativo aberto — que é o que um baker
 * faria — pode capturar um WAL pela metade.
 *
 * Fica no lado portátil do pacote de propósito: é uma instrução só, então o
 * aplicativo desktop roda exatamente este código contra a conexão que o Rust
 * abriu, em vez de uma segunda implementação que poderia divergir.
 */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export async function backupInto(db: SqlDatabase, path: string): Promise<void> {
  try {
    // `VACUUM INTO` não aceita parâmetro ligado para o destino.
    await db.execute(`VACUUM INTO ${quote(path)}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // O próprio SQLite recusa um destino que já existe. A mensagem dele não
    // diz o que fazer; esta diz.
    if (/already exists/i.test(message)) {
      throw new BackupError(
        `já existe um arquivo em ${path} — o backup não sobrescreve nada; escolha outro nome`,
      );
    }
    throw new BackupError(`não consegui escrever o backup em ${path}: ${message}`);
  }
}

/** Literal de texto do SQLite. Só usado para um caminho que o operador escolheu. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Nome do arquivo que guarda o banco substituído numa restauração. */
export function replacedName(targetPath: string, at: Date): string {
  return `${targetPath}.substituido-${at.toISOString().replace(/[:.]/g, '-')}`;
}

export { SqlDriverError };

/**
 * As consultas que decidem se um candidato pode ser restaurado.
 *
 * Ficam aqui, e não dentro da função que abre o arquivo, porque o aplicativo
 * desktop abre o candidato pelo lado Rust e roda exatamente estas — a decisão
 * de aceitar ou recusar um backup tem uma implementação só.
 */
export const INTEGRITY_CHECK = 'PRAGMA integrity_check';
export const SCHEMA_VERSION_QUERY =
  'SELECT version, name FROM schema_migrations ORDER BY version';

export function newestKnownSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}

/** Traduz o resultado das consultas acima na decisão, com o motivo em português. */
export function judgeBackup(input: {
  readonly path: string;
  readonly integrity: string;
  readonly appliedVersions: readonly number[];
}): number {
  if (input.integrity !== 'ok') {
    throw new BackupError(
      `o arquivo ${input.path} está corrompido (${input.integrity}) — não dá para restaurar a partir dele`,
    );
  }
  if (input.appliedVersions.length === 0) {
    throw new BackupError(
      `${input.path} é um banco SQLite, mas não tem o histórico de migrations do TAPS — ` +
        'não é um backup deste aplicativo',
    );
  }
  const schemaVersion = Math.max(...input.appliedVersions);
  const newest = newestKnownSchemaVersion();
  if (schemaVersion > newest) {
    throw new BackupError(
      `o backup está na versão de schema ${schemaVersion} e este aplicativo conhece ` +
        `até a ${newest} — atualize o TAPS antes de restaurar`,
    );
  }
  return schemaVersion;
}

/**
 * Traduz a recusa que vem do driver ao abrir o candidato.
 *
 * `judgeBackup` decide sobre um arquivo que já abriu. Um `.txt` não chega lá:
 * o SQLite recusa antes, com "file is not a database" — em inglês, e sem dizer
 * o que fazer. No aplicativo desktop essa string vinha do Rust e ia crua para a
 * tela (BRES-124).
 *
 * Fica junto do resto do julgamento porque é a mesma decisão: se o arquivo
 * serve ou não, e por quê, em português.
 */
export function judgeUnreadable(path: string, cause: unknown): BackupError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/file is not a database|not a database|SQLITE_NOTADB/i.test(message)) {
    return new BackupError(
      `${path} não é um banco de dados — restaure a partir do arquivo que o próprio botão ` +
        '"Salvar backup" gerou',
    );
  }
  if (/unable to open database file|SQLITE_CANTOPEN/i.test(message)) {
    return new BackupError(
      `não consegui abrir ${path} — confira se o arquivo ainda está onde estava e se você ` +
        'tem permissão de leitura nele',
    );
  }
  // Motivo desconhecido continua aparecendo inteiro: uma mensagem em inglês
  // que ninguém previu é melhor que "erro ao restaurar".
  return new BackupError(`não consegui ler ${path} para conferir: ${message}`);
}
