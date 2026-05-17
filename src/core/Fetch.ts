/**
 * Generic `fetch`-shaped utilities shared across transports.
 *
 * Currently just {@link withTimeout}, but shaped to grow as we add
 * retry/backoff/redirect-policy helpers. Everything in here is wire-
 * agnostic and returns a drop-in `typeof globalThis.fetch` so callers
 * can chain wrappers without touching their own call sites.
 */

/**
 * Wrap a `fetch` implementation so every outbound request is aborted
 * after `timeoutMs` milliseconds. The returned function has the same
 * shape as `globalThis.fetch` and is a drop-in replacement. A
 * caller-supplied `init.signal` is composed with the timeout signal
 * via `AbortSignal.any`, so explicit cancellation still works.
 *
 * @example
 * ```ts
 * import * as Fetch from 'wata'
 *
 * const fetch = Fetch.withTimeout(globalThis.fetch, 30_000)
 * const response = await fetch('https://example.com')
 * ```
 */
export function withTimeout(
  fetch: typeof globalThis.fetch,
  timeoutMs: number,
): typeof globalThis.fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal
    try {
      return await fetch(input, { ...init, signal })
    } finally {
      clearTimeout(timeout)
    }
  }
}
