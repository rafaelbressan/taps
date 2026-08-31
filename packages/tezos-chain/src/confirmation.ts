import { InvariantViolationError } from './errors';
import type { ProtocolConstants } from './rpc/protocol-constants';
import { requireInteger, requireObject, requireString } from './tzkt/fields';
import type { TzKTHttp } from './tzkt/http';

/**
 * Confirmation under Tenderbake.
 *
 * Finality is deterministic: a block at level L is decided once a block at
 * L+1 is built on it, because L+1 carries the quorum of attestations for L
 * (`consensus_threshold_size` of `consensus_committee_size`, 2/3 + 1).
 * Reverting L would need a third of the committee to sign twice at the same
 * level, which is denounceable and slashable.
 *
 * So `DEFAULT_CONFIRMATION_BLOCKS = 8` is not unsafe, it is useless — it is
 * inherited from Emmy*, where finality was probabilistic. And counting blocks
 * is the wrong test anyway: it assumes the chain you saw is the chain that
 * stayed. Re-reading the operation verifies it.
 */

export type OperationStatus =
  /** Hash recorded before injection; not seen in a block yet. */
  | 'pending'
  /** Found in a block, applied, but not yet two levels deep. */
  | 'included'
  /** In block L, head >= L+2, and a re-read confirms block and status. */
  | 'confirmed'
  /** Found in a block with a status other than `applied`. */
  | 'failed'
  /**
   * Past `branch_level + max_operations_time_to_live` and never seen. This is
   * the ONLY point at which "it was never injected" is a safe statement, and
   * therefore the only point at which resending is safe.
   */
  | 'expired';

export interface OperationOutcome {
  readonly hash: string;
  readonly status: OperationStatus;
  readonly level?: number;
  readonly block?: string;
  readonly headLevel: number;
  /** Present when the operation was found with a non-applied status. */
  readonly chainStatus?: string;
}

export interface HeadSource {
  getHeadLevel(): Promise<number>;
}

interface FoundOperation {
  readonly level: number;
  readonly block: string;
  readonly status: string;
}

/**
 * `/v1/operations/{hash}` returns an array. An unknown hash yields an empty
 * array here, while `/v1/operations/{hash}/status` answers 204 with an EMPTY
 * BODY — not 404 — which is what breaks an unconditional `JSON.parse`.
 */
async function findOperation(
  http: TzKTHttp,
  hash: string,
): Promise<FoundOperation | undefined> {
  const { body } = await http.get<unknown[]>(`/v1/operations/${hash}`);
  if (body === undefined || body.length === 0) return undefined;

  const where = `/v1/operations/${hash}`;
  const first = requireObject(body[0], where);
  return {
    level: requireInteger(first, 'level', where),
    block: requireString(first, 'block', where),
    status: requireString(first, 'status', where),
  };
}

export interface ResolveOperationOptions {
  /**
   * Level of the block whose hash was used as the operation's `branch`. After
   * `branchLevel + max_operations_time_to_live` the operation can never be
   * included again.
   */
  readonly branchLevel: number;
  readonly constants: ProtocolConstants;
}

export async function resolveOperationState(
  http: TzKTHttp,
  head: HeadSource,
  hash: string,
  options: ResolveOperationOptions,
): Promise<OperationOutcome> {
  const headLevel = await head.getHeadLevel();
  const found = await findOperation(http, hash);

  if (!found) {
    const expiryLevel = options.branchLevel + options.constants.maxOperationsTimeToLive;
    // Before the branch expires, absence proves nothing: the operation may be
    // sitting in a mempool this indexer has not seen. Resending here is how a
    // retry pays twice.
    return {
      hash,
      status: headLevel > expiryLevel ? 'expired' : 'pending',
      headLevel,
    };
  }

  if (found.status !== 'applied') {
    return {
      hash,
      status: 'failed',
      level: found.level,
      block: found.block,
      chainStatus: found.status,
      headLevel,
    };
  }

  if (headLevel < found.level + 2) {
    return {
      hash,
      status: 'included',
      level: found.level,
      block: found.block,
      headLevel,
    };
  }

  // Step three, and the one that matters: read it again and check it is still
  // in the same block with the same status.
  const reread = await findOperation(http, hash);
  if (!reread || reread.block !== found.block || reread.status !== 'applied') {
    return {
      hash,
      status: reread ? 'failed' : 'pending',
      level: reread?.level ?? found.level,
      block: reread?.block ?? found.block,
      chainStatus: reread?.status,
      headLevel,
    };
  }

  return {
    hash,
    status: 'confirmed',
    level: reread.level,
    block: reread.block,
    headLevel,
  };
}

/**
 * Guard for the retry loop. A previous attempt may only be resent once the
 * chain says it can never land — anything else risks paying twice, and
 * deleting the previous attempt's record destroys the only proof that the
 * money may already have left.
 */
export function assertSafeToResend(outcome: OperationOutcome): void {
  if (outcome.status !== 'expired' && outcome.status !== 'failed') {
    throw new InvariantViolationError(
      'previous attempt is expired or failed before resending',
      `operation ${outcome.hash} is "${outcome.status}" at head ${outcome.headLevel} — ` +
        'resending now can pay the same delegators twice',
    );
  }
}

/** Wall-clock life of a `branch`, derived from the chain. 600 x 6s = 1h today. */
export function branchTtlSeconds(constants: ProtocolConstants): number {
  return constants.maxOperationsTimeToLive * constants.minimalBlockDelay;
}
