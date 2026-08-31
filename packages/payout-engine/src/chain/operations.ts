import {
  resolveOperationState,
  type HeadSource,
  type OperationOutcome,
  type ProtocolConstants,
  type TzKTHttp,
} from '@tezos-suite/chain';
import type { OperationStateSource } from '../engine';

/**
 * Reads the state of a previously injected operation.
 *
 * Two traps the current TAPS falls into are handled inside the chain layer
 * and are the reason this is not a bare fetch: `/v1/operations/{hash}/status`
 * answers 204 WITH AN EMPTY BODY for an unknown hash — not 404 — and absence
 * only means "never injected" once `max_operations_time_to_live` blocks have
 * passed since the branch.
 */
export class TzKTOperationStateSource implements OperationStateSource {
  constructor(
    private readonly http: TzKTHttp,
    private readonly head: HeadSource,
  ) {}

  resolve(
    opHash: string,
    branchLevel: number,
    constants: ProtocolConstants,
  ): Promise<OperationOutcome> {
    return resolveOperationState(this.http, this.head, opHash, {
      branchLevel,
      constants,
    });
  }
}
