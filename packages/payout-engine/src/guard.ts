import {
  ConfigurationError,
  type EstimatedTransfer,
  type Mutez,
  type ProtocolConstants,
  allocationBurn,
} from '@tezos-suite/chain';
import {
  CycleCapExceededError,
  DestinationNotAllowedError,
  StorageAllocationError,
} from './errors';

/**
 * The guards that stand between a computed plan and a signing request.
 *
 * Every one of them has a test that makes it fail. A check whose condition is
 * trivially true is worse than no check: `validateCalculation()` in the
 * current TAPS defines `bakerShare` as `total - payments` and then asserts
 * that they sum to the total, so it passed while every total was zero.
 */

/**
 * Refuses any destination that is not a delegator of this cycle, computed
 * locally from the split. This is the defence against signer misuse: the
 * signer will happily sign a transfer to an attacker's address, because that
 * is a valid generic operation. It has to be refused before it is asked for.
 */
export function assertDestinationsAllowed(
  transfers: readonly { readonly address: string }[],
  allowed: ReadonlySet<string>,
  bakerId: string,
  cycle: number,
): void {
  for (const transfer of transfers) {
    if (!allowed.has(transfer.address)) {
      throw new DestinationNotAllowedError(transfer.address, bakerId, cycle);
    }
  }
}

/**
 * Storage for the allocation burn.
 *
 * `storage_limit: 0` is the fixed value in the current TAPS. Against a
 * destination that is not allocated it does not fail that one transfer: the
 * whole batch comes back `backtracked` and the other recipients show no error
 * of their own. One new delegator freezes the cycle for everybody.
 */
export function assertStorageAllocationCovered(
  transfers: readonly EstimatedTransfer[],
  needsAllocation: ReadonlySet<string>,
  constants: ProtocolConstants,
): void {
  const required = BigInt(constants.originationSize);
  for (const transfer of transfers) {
    if (!needsAllocation.has(transfer.address)) continue;
    if (transfer.storageLimit < required) {
      throw new StorageAllocationError(transfer.address, transfer.storageLimit, required);
    }
  }
}

/**
 * What one allocation costs, derived from the chain every run. The engine
 * needs it to size the minimum payout for an emptied destination.
 */
export function allocationCost(constants: ProtocolConstants): Mutez {
  return allocationBurn(constants);
}

/**
 * Ceiling on what one cycle may move, in mutez. There is no default: a
 * ceiling nobody chose is not a ceiling.
 */
export interface PayoutLimits {
  readonly cycleCapMutez: Mutez;
}

const CYCLE_CAP_ENV = 'TAPS_PAYOUT_CYCLE_CAP_MUTEZ';

/**
 * Reads the per-cycle ceiling from the environment. Missing or unparseable
 * stops the process: booting without a ceiling is booting with an infinite
 * one, and the operator would never know.
 */
export function loadPayoutLimits(env: NodeJS.ProcessEnv = process.env): PayoutLimits {
  const raw = env[CYCLE_CAP_ENV];
  if (!raw || raw.trim() === '') {
    throw new ConfigurationError(
      `${CYCLE_CAP_ENV} is not set — a payout run with no ceiling is a payout run ` +
        'nobody bounded; set it in mutez',
    );
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigurationError(
      `${CYCLE_CAP_ENV} must be a whole number of mutez, got ${JSON.stringify(raw)}`,
    );
  }
  const cycleCapMutez = BigInt(raw.trim());
  if (cycleCapMutez <= 0n) {
    throw new ConfigurationError(`${CYCLE_CAP_ENV} must be greater than zero`);
  }
  return { cycleCapMutez };
}

/** Above the ceiling the run stops and a human approves it, or it does not happen. */
export function assertCycleCap(total: Mutez, limits: PayoutLimits, cycle: number): void {
  if (total > limits.cycleCapMutez) {
    throw new CycleCapExceededError(total, limits.cycleCapMutez, cycle);
  }
}
