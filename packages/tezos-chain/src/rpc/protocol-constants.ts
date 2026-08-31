import { FieldTypeError, MissingFieldError } from '../errors';
import type { RpcSource } from './rpc-source';

/**
 * Protocol constants, read from the chain at runtime. Nothing in this file
 * carries a value: every number below arrives from
 * `/chains/main/blocks/head/context/constants`, and a field that does not
 * arrive raises with its own name rather than becoming a default.
 *
 * Three fields the previous code read no longer exist and are the reason
 * `getConstants()` threw on its first call against any current network:
 *
 *   time_between_blocks  -> minimalBlockDelay + delayIncrementPerRound
 *   endorsers_per_block  -> consensusCommitteeSize
 *   preserved_cycles     -> consensusRightsDelay / blocksPreservationCycles /
 *                           slashingDelay / denunciationPeriod, per use
 */
export interface ProtocolConstants {
  readonly chainId: string;
  readonly protocolHash: string;

  readonly blocksPerCycle: number;
  readonly minimalBlockDelay: number;
  readonly delayIncrementPerRound: number;

  readonly consensusRightsDelay: number;
  readonly blocksPreservationCycles: number;
  readonly consensusCommitteeSize: number;
  readonly consensusThresholdSize: number;

  readonly hardGasLimitPerOperation: bigint;
  readonly hardGasLimitPerBlock: bigint;
  readonly hardStorageLimitPerOperation: bigint;
  readonly maxOperationDataLength: number;
  readonly maxOperationsTimeToLive: number;

  readonly costPerByte: bigint;
  readonly originationSize: number;

  readonly edgeOfStakingOverDelegation: number;
  readonly minimalStake: bigint;

  readonly denunciationPeriod: number;
  readonly slashingDelay: number;

  /** Everything else, exactly as the chain sent it. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Fields removed by Tenderbake / Adaptive Issuance. Reading one is a bug. */
export const REMOVED_CONSTANT_FIELDS = [
  'preserved_cycles',
  'endorsers_per_block',
  'time_between_blocks',
  'blocks_per_roll_snapshot',
  'tokens_per_roll',
  'baking_reward_per_endorsement',
] as const;

const SOURCE = '/chains/main/blocks/head/context/constants';

function requireField(raw: Record<string, unknown>, field: string): unknown {
  if (!(field in raw) || raw[field] === null || raw[field] === undefined) {
    throw new MissingFieldError(field, SOURCE);
  }
  return raw[field];
}

function requireInt(raw: Record<string, unknown>, field: string): number {
  const value = requireField(raw, field);
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new FieldTypeError(field, SOURCE, 'an integer', value);
  }
  return parsed;
}

/** Gas and storage ceilings are compared against summed estimates: bigint. */
function requireBigInt(raw: Record<string, unknown>, field: string): bigint {
  const value = requireField(raw, field);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new FieldTypeError(field, SOURCE, 'an integer', value);
}

export function parseProtocolConstants(
  raw: Record<string, unknown>,
  chainId: string,
  protocolHash: string,
): ProtocolConstants {
  return {
    chainId,
    protocolHash,
    blocksPerCycle: requireInt(raw, 'blocks_per_cycle'),
    minimalBlockDelay: requireInt(raw, 'minimal_block_delay'),
    delayIncrementPerRound: requireInt(raw, 'delay_increment_per_round'),
    consensusRightsDelay: requireInt(raw, 'consensus_rights_delay'),
    blocksPreservationCycles: requireInt(raw, 'blocks_preservation_cycles'),
    consensusCommitteeSize: requireInt(raw, 'consensus_committee_size'),
    consensusThresholdSize: requireInt(raw, 'consensus_threshold_size'),
    hardGasLimitPerOperation: requireBigInt(raw, 'hard_gas_limit_per_operation'),
    hardGasLimitPerBlock: requireBigInt(raw, 'hard_gas_limit_per_block'),
    hardStorageLimitPerOperation: requireBigInt(raw, 'hard_storage_limit_per_operation'),
    maxOperationDataLength: requireInt(raw, 'max_operation_data_length'),
    maxOperationsTimeToLive: requireInt(raw, 'max_operations_time_to_live'),
    costPerByte: requireBigInt(raw, 'cost_per_byte'),
    originationSize: requireInt(raw, 'origination_size'),
    edgeOfStakingOverDelegation: requireInt(raw, 'edge_of_staking_over_delegation'),
    minimalStake: requireBigInt(raw, 'minimal_stake'),
    denunciationPeriod: requireInt(raw, 'denunciation_period'),
    slashingDelay: requireInt(raw, 'slashing_delay'),
    raw: Object.freeze({ ...raw }),
  };
}

/** Seconds in one cycle at round 0 — derived, never written down. */
export function cycleDurationSeconds(constants: ProtocolConstants): number {
  return constants.blocksPerCycle * constants.minimalBlockDelay;
}

/** How long a `branch` stays includable — the only safe "never injected". */
export function operationTtlSeconds(constants: ProtocolConstants): number {
  return constants.maxOperationsTimeToLive * constants.minimalBlockDelay;
}

interface CacheEntry {
  readonly constants: ProtocolConstants;
  readonly expiresAt: number;
}

export interface ProtocolConstantsProviderOptions {
  /** Injected for tests; defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * Caches by `(chain_id, protocol_hash)`, with one cycle as a TTL backstop.
 *
 * The key is the point. A time-keyed cache survives a protocol upgrade and
 * keeps serving the old values through migration day; a protocol-keyed cache
 * invalidates itself the moment the hash changes, because the new hash is a
 * different key and misses by construction.
 */
export class ProtocolConstantsProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private chainId?: string;

  constructor(
    private readonly rpc: RpcSource,
    options: ProtocolConstantsProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  static cacheKey(chainId: string, protocolHash: string): string {
    return `${chainId}@${protocolHash}`;
  }

  /** chain_id cannot change for a given chain, so it is read once. */
  private async resolveChainId(): Promise<string> {
    if (this.chainId === undefined) {
      this.chainId = await this.rpc.getChainId();
    }
    return this.chainId;
  }

  async get(): Promise<ProtocolConstants> {
    const [chainId, protocolHash] = await Promise.all([
      this.resolveChainId(),
      this.rpc.getProtocolHash(),
    ]);
    const key = ProtocolConstantsProvider.cacheKey(chainId, protocolHash);

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.constants;
    }

    const raw = await this.rpc.getRawConstants();
    const constants = parseProtocolConstants(raw, chainId, protocolHash);

    this.cache.set(key, {
      constants,
      expiresAt: this.now() + cycleDurationSeconds(constants) * 1000,
    });
    // An upgrade leaves the previous protocol's entry behind; it can never be
    // served again (its key is unreachable) but it should not accumulate.
    for (const existing of this.cache.keys()) {
      if (existing !== key) this.cache.delete(existing);
    }
    return constants;
  }

  /** Test and operations hook; never called on the money path. */
  clear(): void {
    this.cache.clear();
    this.chainId = undefined;
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}
