import type { ProtocolConstants } from '@tezos-suite/chain';
import { CycleNotDistributableError } from './errors';

/**
 * When a cycle may be distributed.
 *
 * The reward for cycle N is credited in the LAST BLOCK OF CYCLE N — the old
 * `CYCLES_UNTIL_DELIVERED = 5` pays about five days late for nothing. The
 * wait that still makes sense is a different and much shorter one: a
 * denunciation raised during the denunciation period is applied after the
 * slashing delay, and it reduces the amount. Both numbers are read from the
 * chain, so this survives the next time they change.
 */
export function firstDistributableCycle(
  cycle: number,
  constants: ProtocolConstants,
): number {
  return cycle + constants.denunciationPeriod + constants.slashingDelay;
}

export function isCycleDistributable(
  cycle: number,
  headCycle: number,
  constants: ProtocolConstants,
): boolean {
  return headCycle >= firstDistributableCycle(cycle, constants);
}

/**
 * Aborts a run aimed at a cycle whose amount can still change. Re-read the
 * split after this passes: the value is only final once nothing can slash it.
 */
export function assertCycleDistributable(
  cycle: number,
  headCycle: number,
  constants: ProtocolConstants,
): void {
  const first = firstDistributableCycle(cycle, constants);
  if (headCycle < first) {
    throw new CycleNotDistributableError(cycle, headCycle, first);
  }
}
