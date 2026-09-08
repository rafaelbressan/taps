/**
 * The global `fetch`, ready to be stored in a property and called as a method.
 *
 * The browser's `fetch` is a WebIDL operation on `Window`: it requires
 * `this === window`. Stored in a property and called as `this.fetchImpl(url)`,
 * the receiver becomes the client object and Chromium refuses the call:
 *
 *     TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
 *
 * Node does not do this. undici's `fetch` ignores the receiver, which is why a
 * suite of Node and jsdom tests stays green over a client that cannot read the
 * chain from a real browser at all — every read fails, from balance to send.
 *
 * Binding the receiver here fixes it for every caller of this package.
 *
 * This is a function, not a module-level constant, so the global is looked up
 * when a client is constructed rather than when this module is imported: a
 * test that replaces `globalThis.fetch` before constructing gets its stand-in.
 */
export function boundGlobalFetch(): typeof fetch {
  return fetch.bind(globalThis);
}
