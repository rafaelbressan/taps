/**
 * Every error in this package names what was missing or what did not hold.
 * A money path that reports success while returning zero is worse than one
 * that crashes, so nothing here degrades into a default.
 */

export class ChainLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An expected field was absent from an external payload. Never becomes 0. */
export class MissingFieldError extends ChainLayerError {
  constructor(
    readonly field: string,
    readonly source: string,
    readonly detail?: string,
  ) {
    super(
      `missing field "${field}" in ${source}` +
        (detail ? ` (${detail})` : '') +
        ' — refusing to substitute a default',
    );
  }
}

/** A field was present but not of the shape the money path requires. */
export class FieldTypeError extends ChainLayerError {
  constructor(
    readonly field: string,
    readonly source: string,
    readonly expected: string,
    readonly received: unknown,
  ) {
    super(
      `field "${field}" in ${source} must be ${expected}, got ${JSON.stringify(received)}`,
    );
  }
}

/** A checked identity between numbers did not hold. Always aborts. */
export class InvariantViolationError extends ChainLayerError {
  constructor(
    readonly invariant: string,
    readonly detail: string,
  ) {
    super(`invariant "${invariant}" does not hold: ${detail}`);
  }
}

/** HTTP status the caller must see, with the raw body kept for diagnosis. */
export class HttpError extends ChainLayerError {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

/**
 * 429. The TzKT free tier answers from nginx with an HTML body and no
 * `Retry-After`, so this carries no server-provided delay: the backoff is
 * entirely the client's decision.
 */
export class RateLimitedError extends HttpError {
  constructor(url: string, body: string) {
    super(429, url, body);
  }
}

/** The indexer answered 200 with data older than the caller will accept. */
export class StaleIndexerError extends ChainLayerError {
  constructor(
    readonly indexerLevel: number,
    readonly knownLevel: number,
    readonly maxLagBlocks: number,
  ) {
    super(
      `TzKT is ${knownLevel - indexerLevel} blocks behind (level ${indexerLevel} of ${knownLevel}), ` +
        `more than the accepted lag of ${maxLagBlocks}`,
    );
  }
}

/** Configuration that has no safe default was not supplied. */
export class ConfigurationError extends ChainLayerError {}

/** An address the chain would accept but this package will not pay. */
export class AddressError extends ChainLayerError {
  constructor(
    readonly address: string,
    reason: string,
  ) {
    super(`address ${JSON.stringify(address)} rejected: ${reason}`);
  }
}
