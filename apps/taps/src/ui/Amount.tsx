import { xtz } from '../lib/format';

/** Valor em XTZ: monoespaçado, tabular, seis casas, sempre. */
export function Amount({ mutez }: { mutez: bigint }) {
  return (
    <span className="t-amount">
      {xtz(mutez)}
      <span className="t-amount__unit">ꜩ</span>
    </span>
  );
}
