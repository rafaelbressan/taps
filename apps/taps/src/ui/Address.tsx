import { middleTruncate } from '../lib/format';

/** Endereço ou hash. Trunca no meio; o fim é o checksum que a pessoa confere. */
export function Address({ value, title }: { value: string; title?: string }) {
  return (
    <span className="t-address t-address--truncated" title={title ?? value}>
      {middleTruncate(value)}
    </span>
  );
}
