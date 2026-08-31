/**
 * O coorte de teste: os delegadores do baker de Bakingnet, escolhidos para conter
 * de propósito cada caso que derruba o TAPS atual.
 *
 * Um coorte "realista" não serve. O valor deste conjunto está justamente nos casos
 * que ninguém coloca num fixture por acidente.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { InMemorySigner } from '@taquito/signer';
import { b58Encode, PrefixV2 } from '@taquito/utils';

export type CohortRole =
  /** Conta que nunca recebeu nada. É ela que o `storageLimit: 0` derruba — e junto com ela o lote inteiro. */
  | 'unallocated'
  /** Endereço tz4 (BLS). A cadeia paga normalmente; a rejeição do TAPS é 100 % client-side. */
  | 'tz4'
  /** Saldo que rende menos que o custo de pagar. 63 % dos delegadores de um baker real caem aqui. */
  | 'dust'
  /** Delegador comum, alocado. */
  | 'ordinary'
  /** Enchimento para passar de 100 destinatários — o ponto em que o batch atual falha. */
  | 'filler'
  /** Staker: o protocolo já paga; o TAPS pagar de novo é pagar em dobro. */
  | 'staker';

export interface CohortMember {
  id: string;
  role: CohortRole;
  address: string;
  /** Ausente para membros que nunca precisam assinar (ex.: `unallocated`, `tz4`). */
  secretKey?: string;
  /** Saldo delegado atribuído a este membro no split sintético, em mutez (string). */
  delegatedBalance: string;
  /** Conta esvaziada / nunca alocada — precisa de storage para receber. */
  emptied: boolean;
  note: string;
}

export interface Cohort {
  createdAt: string;
  network: string;
  baker: { address: string; secretKey: string };
  members: CohortMember[];
}

/** Quantos delegadores comuns + enchimento. Passa de 100 de propósito. */
export const FILLER_COUNT = 120;

export async function generateEd25519(): Promise<{ address: string; secretKey: string }> {
  const seed = randomBytes(32);
  const sk = b58Encode(new Uint8Array(seed), PrefixV2.Ed25519Seed);
  const signer = new InMemorySigner(sk);
  return { address: await signer.publicKeyHash(), secretKey: sk };
}

/**
 * Endereço tz4 (BLS) válido, gerado sem chave.
 * O harness não precisa assinar por ele — precisa **pagar** para ele, e é isso que
 * a validação client-side do TAPS impede hoje.
 */
export function generateTz4Address(): string {
  return b58Encode(new Uint8Array(randomBytes(20)), PrefixV2.BLS12_381PublicKeyHash);
}

export async function buildCohort(bakerSecretKey: string): Promise<Cohort> {
  const bakerSigner = new InMemorySigner(bakerSecretKey);
  const members: CohortMember[] = [];

  const unallocated = await generateEd25519();
  members.push({
    id: 'unallocated-1',
    role: 'unallocated',
    address: unallocated.address,
    secretKey: unallocated.secretKey,
    // Saldo alto de propósito: a parte dele precisa cobrir com folga o burn de
    // alocação (64 250 mutez), senão ele cai no piso e o caso de borda não é exercido.
    delegatedBalance: '150000000000',
    emptied: true,
    note: 'nunca recebeu nada; exige storage_limit >= origination_size para ser paga',
  });

  members.push({
    id: 'tz4-1',
    role: 'tz4',
    address: generateTz4Address(),
    delegatedBalance: '120000000000',
    emptied: true,
    note: 'endereço BLS; a cadeia cobra o mesmo gas de um tz1',
  });

  const dust = await generateEd25519();
  members.push({
    id: 'dust-1',
    role: 'dust',
    address: dust.address,
    secretKey: dust.secretKey,
    delegatedBalance: '1000',
    emptied: false,
    note: 'valor devido abaixo de qualquer piso razoável; precisa acumular, não sumir',
  });

  const staker = await generateEd25519();
  members.push({
    id: 'staker-1',
    role: 'staker',
    address: staker.address,
    secretKey: staker.secretKey,
    delegatedBalance: '0',
    emptied: false,
    note: 'stakeia; o protocolo credita sozinho — pagar por fora é pagamento duplicado',
  });

  for (let i = 0; i < 3; i++) {
    const m = await generateEd25519();
    members.push({
      id: `ordinary-${i + 1}`,
      role: 'ordinary',
      address: m.address,
      secretKey: m.secretKey,
      delegatedBalance: String(40_000_000_000 - i * 7_000_000_000),
      emptied: false,
      note: 'delegador comum, alocado',
    });
  }

  for (let i = 0; i < FILLER_COUNT; i++) {
    const m = await generateEd25519();
    members.push({
      id: `filler-${i + 1}`,
      role: 'filler',
      address: m.address,
      secretKey: m.secretKey,
      // Espalhado de propósito: valores que não são múltiplos redondos expõem
      // erro de arredondamento que um fixture "bonitinho" esconde.
      delegatedBalance: String(1_000_000_000 + i * 137_117_119),
      emptied: true,
      note: 'enchimento para o lote passar de 100 destinatários',
    });
  }

  return {
    createdAt: new Date().toISOString(),
    network: 'bakingnet',
    baker: { address: await bakerSigner.publicKeyHash(), secretKey: bakerSecretKey },
    members,
  };
}

export async function saveCohort(stateDir: string, cohort: Cohort): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, 'cohort.json');
  await writeFile(path, `${JSON.stringify(cohort, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function loadCohort(stateDir: string): Promise<Cohort> {
  const path = join(stateDir, 'cohort.json');
  if (!existsSync(path)) {
    throw new Error(`coorte não encontrado em ${path}. Rode \`npm run setup\` primeiro.`);
  }
  return JSON.parse(await readFile(path, 'utf8')) as Cohort;
}

/**
 * Relê o estado de alocação do coorte **na cadeia** antes de cada rodada, e troca os
 * endereços de borda que já não são de borda.
 *
 * Sem isto o harness apodrece na primeira execução: depois de receber uma vez, a conta
 * "nunca alocada" passa a existir, o `storage_limit: 0` para de derrubar o lote, e o
 * cenário `conta-nao-alocada` vira uma linha verde que não testa mais nada. Um cenário
 * que não pode reprovar não é cenário.
 */
export async function refreshCohort(
  cohort: Cohort,
  isAllocated: (address: string) => Promise<boolean>,
  log: (msg: string) => void,
): Promise<{ cohort: Cohort; rotated: string[] }> {
  const rotated: string[] = [];

  for (const m of cohort.members) {
    const allocated = await isAllocated(m.address);

    if ((m.role === 'unallocated' || m.role === 'tz4') && allocated) {
      const fresh =
        m.role === 'tz4'
          ? { address: generateTz4Address(), secretKey: undefined }
          : await generateEd25519();
      log(`${m.id}: ${m.address} já está alocada — trocando por ${fresh.address}`);
      rotated.push(m.id);
      m.address = fresh.address;
      if (fresh.secretKey) m.secretKey = fresh.secretKey;
      else delete m.secretKey;
      m.emptied = true;
      continue;
    }

    // `emptied` é estado da cadeia, não campo de configuração.
    m.emptied = !allocated;
  }

  return { cohort, rotated };
}
