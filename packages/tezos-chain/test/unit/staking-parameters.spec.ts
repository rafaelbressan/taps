import { MissingFieldError } from '../../src/errors';
import {
  BILLIONTH,
  edgeAsPercentString,
  parseStakingParameters,
} from '../../src/rpc/staking-parameters';

/** Read from mainnet on 2026-08-29. */
const EVERSTAKE = {
  edge_of_baking_over_staking_billionth: 150000000,
  limit_of_staking_over_baking_millionth: 5000000,
};

describe('staking parameters', () => {
  it('reads the edge as a billionth, not as a percentage', () => {
    const parameters = parseStakingParameters(EVERSTAKE);
    expect(parameters.edgeOfBakingOverStakingBillionth).toBe(150_000_000n);
    // Read as a percentage this number is 150 000 000 %.
    expect(edgeAsPercentString(parameters)).toBe('15.00%');
    expect((parameters.edgeOfBakingOverStakingBillionth * 100n) / BILLIONTH).toBe(15n);
  });

  it('handles a fractional edge without floats', () => {
    // P2P.org: 79 500 000 billionth = 7.95%.
    expect(
      edgeAsPercentString(
        parseStakingParameters({
          edge_of_baking_over_staking_billionth: 79500000,
          limit_of_staking_over_baking_millionth: 9000000,
        }),
      ),
    ).toBe('7.95%');
  });

  it('raises when the edge is absent instead of assuming zero', () => {
    expect(() =>
      parseStakingParameters({ limit_of_staking_over_baking_millionth: 9000000 }),
    ).toThrow(MissingFieldError);
    expect(() =>
      parseStakingParameters({ limit_of_staking_over_baking_millionth: 9000000 }),
    ).toThrow(/edge_of_baking_over_staking_billionth/);
  });
});
