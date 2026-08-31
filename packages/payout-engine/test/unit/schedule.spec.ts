import { CycleNotDistributableError } from '../../src/errors';
import {
  assertCycleDistributable,
  firstDistributableCycle,
  isCycleDistributable,
} from '../../src/schedule';
import { testConstants } from '../helpers/constants';

describe('when a cycle may be distributed', () => {
  it('waits for the denunciation window, not for five cycles', () => {
    const constants = testConstants({ denunciation_period: 1, slashing_delay: 1 });
    expect(firstDistributableCycle(1336, constants)).toBe(1338);
    expect(isCycleDistributable(1336, 1337, constants)).toBe(false);
    expect(isCycleDistributable(1336, 1338, constants)).toBe(true);
  });

  it('moves with the chain, because both numbers are read from it', () => {
    const wider = testConstants({ denunciation_period: 3, slashing_delay: 2 });
    expect(firstDistributableCycle(1336, wider)).toBe(1341);
    expect(isCycleDistributable(1336, 1338, wider)).toBe(false);
  });

  it('refuses a cycle a denunciation can still reduce', () => {
    const constants = testConstants();
    expect(() => assertCycleDistributable(1336, 1337, constants)).toThrow(
      CycleNotDistributableError,
    );
    expect(() => assertCycleDistributable(1336, 1338, constants)).not.toThrow();
  });
});
