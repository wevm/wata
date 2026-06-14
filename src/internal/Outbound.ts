/**
 * Node-only outbound fetch internals for the host `webhook-callback`
 * transport's SSRF-pinned delivery path.
 *
 * Isolated into its own module so the literal `node:*` dynamic imports
 * (`node:dns/promises`, `node:http`, `node:https`) live behind a package
 * `exports` condition: Node resolves this real implementation, while
 * React Native / browser bundlers resolve the inert sibling stub
 * (`Outbound.native.ts`) and never see a `node:*` specifier. This
 * removes the need for consumer-side Metro resolver shims.
 *
 * @see Outbound.native.ts for the non-Node stub.
 */

import * as Transport from '../core/Transport.js'

/** A DNS-resolved address for an outbound host. */
export type ResolvedAddress = {
  /** Resolved IP literal (the value the request is pinned to). */
  address: string
  /** IP family of {@link ResolvedAddress.address}. */
  family: 4 | 6
}

let nodeDnsLookup: Promise<typeof import('node:dns/promises').lookup> | undefined

/**
 * Resolve every IP a hostname maps to (`all`, `verbatim`) using
 * `node:dns`. Returns `undefined` when not running on Node — the caller
 * treats that as "cannot validate outbound DNS" exactly as before.
 */
export async function lookup(hostname: string): Promise<readonly ResolvedAddress[] | undefined> {
  if (!isNodeRuntime()) return undefined
  if (!nodeDnsLookup) nodeDnsLookup = import('node:dns/promises').then(({ lookup }) => lookup)
  const resolve = await nodeDnsLookup
  return (await resolve(hostname, { all: true, verbatim: true })) as readonly ResolvedAddress[]
}

/**
 * Issue an outbound request pinned to an already-resolved IP address —
 * the TCP connection targets {@link fetchWithResolvedAddress.Options.address},
 * while the `Host` header and TLS `servername` carry the original
 * hostname, defeating DNS-rebinding between validation and fetch.
 */
export async function fetchWithResolvedAddress(
  url: URL,
  init: RequestInit | undefined,
  options: fetchWithResolvedAddress.Options,
): Promise<Response> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Transport.TransportError(`unsupported outbound URL protocol \`${url.protocol}\``)
  const { request } =
    url.protocol === 'https:' ? await import('node:https') : await import('node:http')
  const body = await requestBodyBytes(init?.body)
  return await new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('host')) headers.set('host', url.host)
    const req = request(
      {
        headers: nodeHeaders(headers),
        hostname: options.address,
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        port: url.port ? Number(url.port) : undefined,
        protocol: url.protocol,
        servername: options.servername,
      },
      (res) => {
        const chunks: Uint8Array[] = []
        res.on('data', (chunk: string | Uint8Array) => {
          chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
        })
        res.on('error', reject)
        res.on('end', () => {
          const status = res.statusCode
          if (!status) {
            reject(new Transport.TransportError('outbound response missing HTTP status'))
            return
          }
          const bytes = concatBytes(chunks)
          const init: ResponseInit = {
            headers: responseHeaders(res.rawHeaders),
            status,
            ...(res.statusMessage ? { statusText: res.statusMessage } : {}),
          }
          resolve(new Response(bytes.buffer, init))
        })
      },
    )
    req.on('error', reject)
    const signal = init?.signal
    const abort = () => req.destroy(new Error('outbound request aborted'))
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', abort))
    if (body) req.write(body)
    req.end()
  })
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

async function requestBodyBytes(
  body: BodyInit | null | undefined,
): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new Transport.TransportError('unsupported outbound request body type')
}

function nodeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function responseHeaders(rawHeaders: string[]): Headers {
  const headers = new Headers()
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]
    const value = rawHeaders[i + 1]
    if (name && value !== undefined) headers.append(name, value)
  }
  return headers
}

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node
}
