/**
 * Non-Node stub for {@link file://./Outbound.ts}, selected by the
 * `react-native` / `browser` package `exports` conditions.
 *
 * Contains no `node:*` imports, so React Native (Metro) and browser
 * bundlers never pull node builtins into the `wata/host` graph. The
 * `webhook-callback` SSRF-pinned fetch path is Node-only; off Node,
 * {@link lookup} reports "unsupported" (matching the historical
 * non-Node behavior) and {@link fetchWithResolvedAddress} is never
 * reached.
 */

import * as Transport from '../core/Transport.js'

/** A DNS-resolved address for an outbound host. */
export type ResolvedAddress = {
  /** Resolved IP literal (the value the request is pinned to). */
  address: string
  /** IP family of {@link ResolvedAddress.address}. */
  family: 4 | 6
}

/** Always `undefined` off Node — the runtime cannot resolve/validate DNS. */
export async function lookup(_hostname: string): Promise<readonly ResolvedAddress[] | undefined> {
  return undefined
}

/** Unreachable off Node: {@link lookup} returns `undefined`, so no pinned fetch occurs. */
export async function fetchWithResolvedAddress(
  _url: URL,
  _init: RequestInit | undefined,
  _options: fetchWithResolvedAddress.Options,
): Promise<Response> {
  throw new Transport.UnsupportedError('pinned outbound fetch is unavailable outside Node')
}

export declare namespace fetchWithResolvedAddress {
  /** Options for {@link fetchWithResolvedAddress}. */
  type Options = {
    /** Resolved IP literal the request connects to. */
    address: string
    /** Original hostname, used for the `Host` header and TLS SNI. */
    servername: string
  }
}
