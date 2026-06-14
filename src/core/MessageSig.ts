/**
 * RFC 9421 HTTP Message Signatures + RFC 9530 Content-Digest helpers.
 *
 * Narrow, HTTP-message-shape-based — accepts a plain
 * `{ method, url, headers, body }` shape rather than a `Request` /
 * `Response`. Adapters (the consumer / host webhook-callback
 * transports, the future relay) convert between web-standard
 * `Request` / `Response` objects and this shape at the boundary so
 * the signing core has no dependency on `fetch` runtimes.
 *
 * Scope:
 *
 * - Signing algorithm is fixed to **Ed25519** (the only algorithm uRPC
 *   uses on the wire). Other RFC 9421 algorithms are intentionally
 *   unsupported.
 * - Supports the derived components used by uRPC: `@method`,
 *   `@target-uri`, `@authority`, `@path`, `@query`, and
 *   `@query-param;name="..."` (RFC 9421 §2.2.8 — the named query
 *   parameter's value, form-decoded then canonically re-encoded).
 *   Other derived components are not parsed.
 * - Supports verbatim header components (lowercased name, value
 *   pulled from the supplied `headers` map after leading/trailing
 *   whitespace trim per [RFC 9421 §2.1](https://www.rfc-editor.org/rfc/rfc9421#name-http-fields)).
 * - Signature-Input parameters: `created` (integer), `keyid`
 *   (string), `alg` (string), `nonce` (string), `expires` (integer).
 * - {@link contentDigest} produces the RFC 9530 `sha-256=:<base64>:`
 *   field value (standard base64 with padding).
 *
 * Higher-level concerns (replay protection via a `Store` nonce store,
 * SSRF address checks, Discovery `callback_urls` enforcement) live
 * in the transports that call into this module.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { Base64, Bytes, Ed25519, Hex } from 'ox'

import * as Errors from './Errors.js'

/**
 * HTTP message shape consumed by {@link sign} / {@link verify}.
 *
 * `url` is the fully-qualified request URI (with scheme, authority,
 * path, and any query string). It is the only source for the
 * `@target-uri`, `@authority`, `@path`, and `@query` derived
 * components — callers MUST pass the URL exactly as it appears on the
 * wire so both sides reconstruct identical signature bases.
 */
export type HttpMessage = {
  /**
   * Header map. Keys are matched case-insensitively. Values MUST be
   * the verbatim field-values as they appear on the wire (leading/
   * trailing whitespace is trimmed inside {@link signatureBase}).
   */
  headers: Record<string, string>
  /** HTTP method (e.g. `'POST'`). Case is preserved on the wire; canonicalized to uppercase in the signature base per RFC 9421 §2.2.1. */
  method: string
  /** Fully-qualified request URI (`https://host[:port]/path[?query]`). */
  url: string
}

/**
 * RFC 9421 §2.3 signature parameters. All optional — only `created`
 * and `keyid` are typically populated for uRPC traffic, plus `alg`
 * and `nonce` for stronger anti-replay coverage.
 */
export type Parameters = {
  /** `alg` parameter — sf-string. Pinned to `'ed25519'` for uRPC. */
  alg?: string | undefined
  /** `created` parameter — sf-integer (UNIX seconds). */
  created?: number | undefined
  /** `expires` parameter — sf-integer (UNIX seconds). */
  expires?: number | undefined
  /** `keyid` parameter — sf-string. Identifier of the signing key. */
  keyid?: string | undefined
  /** `nonce` parameter — sf-string. Random anti-replay value. */
  nonce?: string | undefined
}

/**
 * Pair of header values produced by {@link sign}. Callers attach them
 * directly to the outbound request (or to a `Headers` object built
 * for `fetch`).
 */
export type Headers = {
  /** `Signature` header value (`<label>=:<base64-sig>:`). */
  signature: string
  /** `Signature-Input` header value (`<label>=(...);created=...;...`). */
  signatureInput: string
}

/** Default label applied to `Signature` / `Signature-Input` headers when not overridden. */
export const defaultLabel = 'sig'

/**
 * Compute the RFC 9530 `Content-Digest` field value for an HTTP
 * message body.
 *
 * Returns a `sha-256=:<base64>:` string ready to be set as the
 * `Content-Digest` header. Standard base64 (with padding) per
 * RFC 9530 §3.
 *
 * @example
 * ```ts
 * import { MessageSig } from 'wata'
 *
 * const digest = MessageSig.contentDigest('{"hello":"world"}')
 * // sha-256=:k2oKr5pX8j/...:
 * ```
 */
export function contentDigest(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? Bytes.fromString(body) : body
  return `sha-256=:${Base64.fromBytes(sha256(bytes))}:`
}

/**
 * Build the RFC 9421 §2.5 signature base string for a given
 * HTTP message, component list, and parameters.
 *
 * The returned string is the exact byte sequence that gets fed into
 * the Ed25519 signing primitive. Both peers MUST reproduce it
 * byte-for-byte for the signature to verify.
 *
 * @example
 * ```ts
 * import { MessageSig } from 'wata'
 *
 * const base = MessageSig.signatureBase({
 *   message: { method: 'POST', url: 'https://example.com/foo', headers: { 'content-type': 'application/json' } },
 *   components: ['@method', '@target-uri', 'content-type'],
 *   parameters: { created: 1730999940, keyid: 'consumer.example#identity' },
 * })
 * ```
 */
export function signatureBase(options: signatureBase.Options): string {
  const { components, message, parameters } = options
  const lines: string[] = []
  for (const component of components) {
    lines.push(`${serializeComponent(component)}: ${componentValue(component, message)}`)
  }
  lines.push(`"@signature-params": ${innerListAndParams(components, parameters)}`)
  return lines.join('\n')
}

export declare namespace signatureBase {
  /** Options for {@link signatureBase}. */
  type Options = {
    /** Components covered by the signature, in canonical order. */
    components: readonly string[]
    /** HTTP message the signature covers. */
    message: HttpMessage
    /** RFC 9421 §2.3 parameters. */
    parameters: Parameters
  }
}

/**
 * Sign an HTTP message under an Ed25519 private key and return the
 * `Signature` / `Signature-Input` header pair.
 *
 * @example
 * ```ts
 * import { MessageSig } from 'wata'
 *
 * const { signature, signatureInput } = MessageSig.sign({
 *   privateKey: '0x...',
 *   message: { method: 'POST', url: '...', headers: { ... } },
 *   components: ['@method', '@target-uri', '@authority', 'content-type', 'content-digest'],
 *   parameters: { created: Math.floor(Date.now() / 1000), keyid: 'consumer.example#identity', alg: 'ed25519', nonce: '...' },
 * })
 * ```
 */
export function sign(options: sign.Options): Headers {
  const { components, label = defaultLabel, message, parameters, privateKey } = options
  const base = signatureBase({ components, message, parameters })
  const signatureBytes = Ed25519.sign({ as: 'Bytes', payload: Bytes.fromString(base), privateKey })
  return {
    signature: `${label}=:${Base64.fromBytes(signatureBytes)}:`,
    signatureInput: `${label}=${innerListAndParams(components, parameters)}`,
  }
}

export declare namespace sign {
  /** Options for {@link sign}. */
  type Options = signatureBase.Options & {
    /** Optional label applied to both headers. Defaults to {@link defaultLabel}. */
    label?: string | undefined
    /** 32-byte Ed25519 private seed (`0x`-prefixed hex). */
    privateKey: Hex.Hex
  }
}

/**
 * Verify the `Signature` / `Signature-Input` header pair on an
 * inbound HTTP message under the supplied Ed25519 public key.
 *
 * Returns `true` if the signature verifies under the canonical
 * RFC 9421 signature base reconstructed from `message`,
 * `components`, and `parameters` (parsed out of `Signature-Input`).
 *
 * Throws {@link InvalidSignatureError} if either header is missing,
 * the supplied `label` doesn't appear, or the structured fields fail
 * to parse. Throws {@link MissingComponentError} when `requiredComponents`
 * is supplied and the signature does not cover one of them.
 *
 * @example
 * ```ts
 * import { MessageSig } from 'wata'
 *
 * const ok = MessageSig.verify({
 *   publicKey: '0x...',
 *   message: { method: 'POST', url: '...', headers: { 'signature': ..., 'signature-input': ..., ... } },
 *   requiredComponents: ['@method', '@target-uri', '@authority', 'content-type', 'content-digest'],
 * })
 * ```
 */
export function verify(options: verify.Options): boolean {
  const { label = defaultLabel, message, publicKey, requiredComponents } = options
  const signatureInputRaw = getHeader(message.headers, 'signature-input')
  const signatureRaw = getHeader(message.headers, 'signature')
  if (!signatureInputRaw) throw new InvalidSignatureError('missing `Signature-Input` header')
  if (!signatureRaw) throw new InvalidSignatureError('missing `Signature` header')
  const parsedInput = parseSignatureInput(signatureInputRaw, label)
  const signatureBytes = parseSignatureValue(signatureRaw, label)
  if (requiredComponents) {
    const have = new Set(parsedInput.components.map(canonicalComponent))
    for (const required of requiredComponents) {
      if (!have.has(canonicalComponent(required))) throw new MissingComponentError(required)
    }
  }
  const base = signatureBase({
    components: parsedInput.components,
    message,
    parameters: parsedInput.parameters,
  })
  return Ed25519.verify({
    payload: Bytes.fromString(base),
    publicKey,
    signature: signatureBytes,
  })
}

export declare namespace verify {
  /** Options for {@link verify}. */
  type Options = {
    /** Optional label to look up. Defaults to {@link defaultLabel}. */
    label?: string | undefined
    /** HTTP message the signature covers. Headers MUST include `Signature` + `Signature-Input`. */
    message: HttpMessage
    /** 32-byte Ed25519 public key (`0x`-prefixed hex). */
    publicKey: Hex.Hex
    /**
     * Optional list of components that MUST be covered by the
     * signature. When supplied, {@link verify} throws
     * {@link MissingComponentError} if any required component is
     * absent from the parsed `Signature-Input` inner list.
     */
    requiredComponents?: readonly string[] | undefined
  }
}

/** Parsed `Signature-Input` header for one label. */
export type ParsedSignatureInput = {
  /** Inner list of covered components (verbatim, including `@` prefixes). */
  components: readonly string[]
  /** Label this entry was registered under (e.g. `'sig'`). */
  label: string
  /** Structured field parameters following the inner list. */
  parameters: Parameters
}

/**
 * Parse a single `Signature-Input` entry by label. Throws
 * {@link InvalidSignatureError} on shape failure.
 *
 * @example
 * ```ts
 * import { MessageSig } from 'wata'
 *
 * const parsed = MessageSig.parseSignatureInput(
 *   'sig=("@method" "@target-uri");created=1730999940;keyid="abc"',
 *   'sig',
 * )
 * parsed.components       // ['@method', '@target-uri']
 * parsed.parameters.created // 1730999940
 * ```
 */
export function parseSignatureInput(value: string, label = defaultLabel): ParsedSignatureInput {
  const entries = splitTopLevelCommas(value)
  for (const entry of entries) {
    const equalsIndex = entry.indexOf('=')
    if (equalsIndex < 0) continue
    const candidateLabel = entry.slice(0, equalsIndex).trim()
    if (candidateLabel !== label) continue
    const rest = entry.slice(equalsIndex + 1).trim()
    if (!rest.startsWith('('))
      throw new InvalidSignatureError(`expected inner-list for label \`${label}\``)
    const closeIndex = rest.indexOf(')')
    if (closeIndex < 0)
      throw new InvalidSignatureError(`unterminated inner-list for label \`${label}\``)
    const innerListRaw = rest.slice(1, closeIndex)
    const components = parseInnerList(innerListRaw)
    const paramsRaw = rest.slice(closeIndex + 1)
    const parameters = parseParameters(paramsRaw)
    return { components, label, parameters }
  }
  throw new InvalidSignatureError(`Signature-Input missing label \`${label}\``)
}

/** Parsed `Signature` header for one label. */
export type ParsedSignature = {
  /** Label this entry was registered under. */
  label: string
  /** Raw signature bytes (decoded from the base64 byte-sequence wrapper). */
  signature: Uint8Array
}

/**
 * Parse a single `Signature` entry by label. Throws
 * {@link InvalidSignatureError} on shape failure.
 */
export function parseSignature(value: string, label = defaultLabel): ParsedSignature {
  return { label, signature: parseSignatureValue(value, label) }
}

function parseSignatureValue(value: string, label: string): Uint8Array {
  const entries = splitTopLevelCommas(value)
  for (const entry of entries) {
    const equalsIndex = entry.indexOf('=')
    if (equalsIndex < 0) continue
    const candidateLabel = entry.slice(0, equalsIndex).trim()
    if (candidateLabel !== label) continue
    const raw = entry.slice(equalsIndex + 1).trim()
    if (!raw.startsWith(':') || !raw.endsWith(':'))
      throw new InvalidSignatureError(`expected byte-sequence wrapper for label \`${label}\``)
    const base64 = raw.slice(1, -1)
    try {
      return Base64.toBytes(base64)
    } catch (cause) {
      throw new InvalidSignatureError(`signature for label \`${label}\` is not valid base64`, {
        cause: cause as Error,
      })
    }
  }
  throw new InvalidSignatureError(`Signature missing label \`${label}\``)
}

function parseInnerList(raw: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }
    if (ch !== '"')
      throw new InvalidSignatureError(`expected quoted component in inner-list at position ${i}`)
    const end = raw.indexOf('"', i + 1)
    if (end < 0) throw new InvalidSignatureError('unterminated quoted component in inner-list')
    const componentName = raw.slice(i + 1, end)
    // Consume any trailing parameters (e.g. `;name="wait"`) verbatim,
    // respecting quoted parameter values that may contain spaces, up to
    // the next top-level whitespace that separates inner-list members.
    let j = end + 1
    let inString = false
    while (j < raw.length) {
      const c = raw[j]
      if (inString) {
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '"') inString = false
        j += 1
        continue
      }
      if (c === ' ' || c === '\t') break
      if (c === '"') inString = true
      j += 1
    }
    out.push(componentName + raw.slice(end + 1, j))
    i = j
  }
  return out
}

function parseParameters(raw: string): Parameters {
  const out: Parameters = {}
  // Parameters are `;name=value;name=value;...`. Values are either
  // sf-strings (`"..."`) or sf-integers (bare digits). For uRPC we
  // only emit the small fixed set the spec uses.
  let i = 0
  while (i < raw.length) {
    if (raw[i] !== ';')
      throw new InvalidSignatureError(`expected \`;\` between parameters at position ${i}`)
    i += 1
    let nameEnd = i
    while (nameEnd < raw.length && raw[nameEnd] !== '=' && raw[nameEnd] !== ';') nameEnd += 1
    const name = raw.slice(i, nameEnd).trim()
    if (!name) throw new InvalidSignatureError(`empty parameter name at position ${i}`)
    if (nameEnd >= raw.length || raw[nameEnd] === ';') {
      // Bare boolean true — not used by uRPC; skip silently.
      i = nameEnd
      continue
    }
    i = nameEnd + 1
    if (raw[i] === '"') {
      const end = raw.indexOf('"', i + 1)
      if (end < 0) throw new InvalidSignatureError('unterminated string parameter value')
      const value = raw.slice(i + 1, end)
      assignParameter(out, name, value)
      i = end + 1
    } else {
      let end = i
      while (end < raw.length && raw[end] !== ';') end += 1
      const valueRaw = raw.slice(i, end).trim()
      const asInt = Number(valueRaw)
      if (!Number.isFinite(asInt))
        throw new InvalidSignatureError(`expected integer parameter value, got \`${valueRaw}\``)
      assignParameter(out, name, asInt)
      i = end
    }
  }
  return out
}

function assignParameter(target: Parameters, name: string, value: string | number): void {
  switch (name) {
    case 'alg':
      if (typeof value !== 'string')
        throw new InvalidSignatureError('expected `alg` to be a string')
      target.alg = value
      return
    case 'created':
      if (typeof value !== 'number')
        throw new InvalidSignatureError('expected `created` to be an integer')
      target.created = value
      return
    case 'expires':
      if (typeof value !== 'number')
        throw new InvalidSignatureError('expected `expires` to be an integer')
      target.expires = value
      return
    case 'keyid':
      if (typeof value !== 'string')
        throw new InvalidSignatureError('expected `keyid` to be a string')
      target.keyid = value
      return
    case 'nonce':
      if (typeof value !== 'string')
        throw new InvalidSignatureError('expected `nonce` to be a string')
      target.nonce = value
      return
    default:
      // Unknown parameters are ignored on parse so forward-compatible
      // extensions (e.g. `tag`, `key`) don't break verification.
      return
  }
}

/**
 * Split a component identifier into its lowercased name and its
 * verbatim parameter suffix (e.g. `@query-param;name="wait"` →
 * `{ name: '@query-param', params: ';name="wait"' }`). The parameter
 * suffix is preserved case-sensitively so a quoted `name` value is not
 * mangled (RFC 9421 §2.1.1).
 */
function splitComponent(component: string): { name: string; params: string } {
  const semi = component.indexOf(';')
  if (semi < 0) return { name: component.toLowerCase(), params: '' }
  return { name: component.slice(0, semi).toLowerCase(), params: component.slice(semi) }
}

/**
 * Canonical component identifier used for `requiredComponents`
 * matching and dedup: the name is lowercased, the parameter suffix is
 * preserved verbatim (RFC 9421 §2.1.1 — names are case-insensitive,
 * parameter values are not).
 */
function canonicalComponent(component: string): string {
  const { name, params } = splitComponent(component)
  return `${name}${params}`
}

/** Serialize a component identifier for the signature base / inner list. */
function serializeComponent(component: string): string {
  const { name, params } = splitComponent(component)
  return `"${name}"${params}`
}

/** Extract the `name` parameter value from a `@query-param` suffix. */
function queryParamName(params: string): string {
  const match = /;\s*name="((?:[^"\\]|\\.)*)"/.exec(params)
  if (!match) throw new InvalidSignatureError('`@query-param` requires a `name` parameter')
  return formDecode(match[1] ?? '')
}

/** RFC 9421 §2.2.8 value of a named query parameter. */
function queryParamValue(url: string, name: string): string {
  const search = new URL(url).search
  const query = search.startsWith('?') ? search.slice(1) : search
  let found: string | undefined
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawKey = eq < 0 ? pair : pair.slice(0, eq)
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1)
    if (formDecode(rawKey) !== name) continue
    if (found !== undefined)
      throw new InvalidSignatureError(`duplicate query parameter \`${name}\` for \`@query-param\``)
    found = rawValue
  }
  if (found === undefined)
    throw new InvalidSignatureError(`query parameter \`${name}\` not found for \`@query-param\``)
  // Form-decode the raw value, then canonically percent-re-encode it so
  // both peers reproduce identical bytes regardless of how the value was
  // originally escaped (RFC 9421 §2.2.8).
  return encodeURIComponent(formDecode(found))
}

/** `application/x-www-form-urlencoded` decode: `+` → space, then percent-decode. */
function formDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '))
}

function componentValue(component: string, message: HttpMessage): string {
  const { name, params } = splitComponent(component)
  if (name === '@method') return message.method.toUpperCase()
  if (name === '@target-uri') return message.url
  if (name === '@authority') return authorityOf(message.url)
  if (name === '@path') return new URL(message.url).pathname
  if (name === '@query') {
    const url = new URL(message.url)
    return url.search.length > 0 ? url.search : '?'
  }
  if (name === '@query-param') return queryParamValue(message.url, queryParamName(params))
  if (name.startsWith('@'))
    throw new InvalidSignatureError(`unsupported derived component \`${component}\``)
  const value = getHeader(message.headers, name)
  if (value === undefined) throw new MissingHeaderError(component)
  // RFC 9421 §2.1 — trim leading/trailing whitespace from the
  // field-value before insertion in the signature base. We do not
  // collapse multi-line obs-fold (deprecated in HTTP/1.1) or join
  // multi-instance headers; callers are expected to pre-collapse.
  return value.trim()
}

function authorityOf(url: string): string {
  const parsed = new URL(url)
  // RFC 9421 §2.2.4 — `@authority` is lowercase host plus the port
  // when non-default. http:80 and https:443 are the defaults.
  const host = parsed.hostname.toLowerCase()
  const port = parsed.port
  if (!port) return host
  if (parsed.protocol === 'https:' && port === '443') return host
  if (parsed.protocol === 'http:' && port === '80') return host
  return `${host}:${port}`
}

function innerListAndParams(components: readonly string[], parameters: Parameters): string {
  const inner = components.map(serializeComponent).join(' ')
  const params: string[] = []
  if (parameters.created !== undefined) params.push(`created=${parameters.created}`)
  if (parameters.keyid !== undefined) params.push(`keyid="${parameters.keyid}"`)
  if (parameters.alg !== undefined) params.push(`alg="${parameters.alg}"`)
  if (parameters.expires !== undefined) params.push(`expires=${parameters.expires}`)
  if (parameters.nonce !== undefined) params.push(`nonce="${parameters.nonce}"`)
  return params.length > 0 ? `(${inner});${params.join(';')}` : `(${inner})`
}

function splitTopLevelCommas(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let inString = false
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (inString) {
      if (ch === '\\' && i + 1 < value.length) {
        i += 1
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i))
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/**
 * Thrown when an RFC 9421 signature fails to parse, is structurally
 * malformed, or doesn't verify. Wraps the original cause when one is
 * available.
 */
export class InvalidSignatureError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'MessageSig.InvalidSignatureError'
}

/**
 * Thrown when {@link verify} is invoked with `requiredComponents` and
 * the parsed signature input does not cover one of them.
 */
export class MissingComponentError extends Errors.BaseError {
  override name = 'MessageSig.MissingComponentError'

  constructor(component: string) {
    super(`signature does not cover required component \`${component}\``)
  }
}

/**
 * Thrown when a header component named in `components` is absent
 * from the supplied {@link HttpMessage.headers} map at signing /
 * verification time.
 */
export class MissingHeaderError extends Errors.BaseError {
  override name = 'MessageSig.MissingHeaderError'

  constructor(component: string) {
    super(`missing header \`${component}\` for signature base`)
  }
}
