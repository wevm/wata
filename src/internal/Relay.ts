/**
 * Shared relay-transport protocol internals.
 *
 * Implements the pure protocol derivations of the
 * [uRPC Relay spec](https://github.com/tempoxyz/urpc/blob/main/specs/transport-relay.md)
 * shared by the consumer transport (`wata`), host transport
 * (`wata/host`), and their tests:
 *
 * - {@link channelId} — routing identifier derived from the session
 *   anchor + pairing secret (§2.3.2).
 * - {@link hostProof} — the host's anti-MITM HMAC binding its ephemeral
 *   public key to the out-of-band `pairing_secret` (§6.4, §10.3).
 * - {@link buildUri} / {@link parseUri} — the initial pairing link
 *   delivered out-of-band via QR code or deep link (§2.3.3).
 *
 * Wire mechanics (signed SSE subscriptions, signed POSTs, AEAD session
 * state) live with the transports; the relay server only ever sees the
 * `channel_id` — never `pairing_secret` — so it cannot enumerate
 * channels or forge a `host_proof`.
 */

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Base64, Bytes, Hash, Hex } from 'ox'

import * as Aad from '../core/Aad.js'
import * as Aead from '../core/Aead.js'
import * as Crypto from '../core/Crypto.js'
import * as Envelope from '../core/Envelope.js'
import * as Errors from '../core/Errors.js'
import * as MessageSig from '../core/MessageSig.js'
import * as Nonce from '../core/Nonce.js'
import type * as Session from '../core/Session.js'
import * as Transport from '../core/Transport.js'
import * as Uri from './Uri.js'

/** ASCII transport identifier bound into the HKDF `info` blob (§6.6). */
export const transportId = 'relay'

/** Initial-link format version produced and accepted by this implementation (§2.3.3). */
export const version = 1

/** Domain-separation prefix mixed into the {@link channelId} digest (§2.3.2). */
export const channelIdPrefix = 'urpc/v1/channel'

/** Domain-separation prefix mixed into the {@link hostProof} HMAC (§10.3). */
export const hostProofPrefix = 'urpc/v1/host-proof'

/**
 * Default gap, in milliseconds, between successive short-poll requests
 * once a poll comes back empty. Kept short so receive latency stays low,
 * while each request itself returns instantly (`wait=0`) — no long-held
 * connections for proxies/mobile networks to mangle. The relay's
 * buffering (spec §5.4) covers the gaps between polls.
 */
const pollIntervalDefault = 2_000

/** Query parameter names of the initial link (§2.3.3). */
export const uriParams = {
  /** Consumer's X25519 public key, unpadded base64url. */
  consumerPublicKey: 'consumer_pubkey',
  /** 32-byte pairing secret, unpadded base64url. */
  pairingSecret: 'pairing_secret',
  /** HTTPS URL of the relay endpoint prefixing `/:channel_id/:peer`. */
  relay: 'relay',
  /** Initial-link format version. */
  version: 'version',
} as const

/**
 * Derive the relay-local routing identifier (§2.3.2):
 *
 * ```text
 * channel_id = base64url(
 *   SHA-256("urpc/v1/channel" || consumer_pubkey || SHA-256(pairing_secret))
 * )
 * ```
 *
 * `SHA-256(pairing_secret)` is mixed in — never the secret itself — so
 * relay logs cannot recover `pairing_secret` from `channel_id`. The
 * result is 43 characters (32 bytes, unpadded base64url) and is used
 * purely for routing; it is **not** an input to the key schedule.
 */
export function channelId(options: channelId.Options): string {
  const publicKey = Bytes.from(options.consumerPublicKey)
  if (publicKey.length !== 32)
    throw new Errors.ProtocolError('consumerPublicKey must be 32 bytes', {
      details: `received ${publicKey.length} bytes`,
    })
  const pairingSecret = Bytes.from(options.pairingSecret)
  if (pairingSecret.length !== 32)
    throw new Errors.ProtocolError('pairingSecret must be 32 bytes', {
      details: `received ${pairingSecret.length} bytes`,
    })
  const digest = Hash.sha256(
    Bytes.concat(
      Bytes.fromString(channelIdPrefix),
      publicKey,
      Hash.sha256(pairingSecret, { as: 'Bytes' }),
    ),
    { as: 'Bytes' },
  )
  return Base64.fromBytes(digest, { pad: false, url: true })
}

export declare namespace channelId {
  /** Options for {@link channelId}. */
  type Options = {
    /** Consumer's raw 32-byte X25519 public key (the session anchor). */
    consumerPublicKey: Hex.Hex | Bytes.Bytes
    /** 32-byte out-of-band pairing secret. */
    pairingSecret: Hex.Hex | Bytes.Bytes
  }
}

/**
 * Compute the host's anti-MITM proof (§6.4, §10.3):
 *
 * ```text
 * host_proof = HMAC-SHA256(
 *   key     = pairing_secret,
 *   message = "urpc/v1/host-proof"
 *             || consumer_pubkey || host_pubkey || SHA-256(shared_secret)
 * )
 * ```
 *
 * The relay never sees `pairing_secret`, so a relay substituting its own
 * `host_pubkey` cannot produce a valid proof. Both sides compute this —
 * the host to include it in `hello`, the consumer to verify it (in
 * constant time) before deriving any AEAD keys.
 */
export function hostProof(options: hostProof.Options): Hex.Hex {
  const message = Bytes.concat(
    Bytes.fromString(hostProofPrefix),
    Bytes.from(options.consumerPublicKey),
    Bytes.from(options.hostPublicKey),
    Hash.sha256(Bytes.from(options.sharedSecret), { as: 'Bytes' }),
  )
  return Hex.fromBytes(hmac(sha256, Bytes.from(options.pairingSecret), message))
}

export declare namespace hostProof {
  /** Options for {@link hostProof}. */
  type Options = {
    /** Consumer's raw 32-byte X25519 public key. */
    consumerPublicKey: Hex.Hex | Bytes.Bytes
    /** Host's raw 32-byte X25519 public key. */
    hostPublicKey: Hex.Hex | Bytes.Bytes
    /** 32-byte out-of-band pairing secret. */
    pairingSecret: Hex.Hex | Bytes.Bytes
    /** X25519 ECDH shared secret between the two ephemeral keypairs. */
    sharedSecret: Hex.Hex | Bytes.Bytes
  }
}

/** Decode a 32-byte unpadded base64url pairing secret into hex form. */
export function decodeSecret(value: string): Hex.Hex {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('expected 43 base64url characters')
    const bytes = Base64.toBytes(value)
    if (bytes.length !== 32) throw new Error('expected 32 bytes')
    return Hex.fromBytes(bytes)
  } catch (cause) {
    throw new Errors.ProtocolError('pairing secret must be 32-byte unpadded base64url', {
      cause: cause as Error,
    })
  }
}

/** Encode a 32-byte hex pairing secret as unpadded base64url. */
export function encodeSecret(secret: Hex.Hex | Bytes.Bytes): string {
  const bytes = Bytes.from(secret)
  if (bytes.length !== 32) throw new Errors.ProtocolError('pairing secret must be 32 bytes')
  return Base64.fromBytes(bytes, { pad: false, url: true })
}

/**
 * Build the initial pairing link delivered out-of-band (§2.3.3).
 *
 * The {@link buildUri.Options.target} selects the link's target:
 * - omitted → the shared `urpc://?version=1&...` scheme for any-host
 *   flows (the default);
 * - a bare scheme like `'example-wallet'` → `example-wallet://?version=1&...`, a
 *   wallet-specific App Link;
 * - a full universal link like `'https://wallet.example/urpc'` →
 *   `https://wallet.example/urpc?version=1&...`, the RECOMMENDED format
 *   when the target host is known.
 *
 * Only public material appears in the link's named parameters besides
 * `pairing_secret`, which is the one out-of-band secret the protocol
 * depends on — the link MUST be treated as confidential and used once.
 */
export function buildUri(options: buildUri.Options): string {
  const { allowPrivateNetwork, consumerPublicKey, pairingSecret, relay, target } = options
  const search = new URLSearchParams()
  search.set(
    uriParams.consumerPublicKey,
    Crypto.encodePublicKey(Hex.fromBytes(Bytes.from(consumerPublicKey))),
  )
  search.set(uriParams.pairingSecret, encodeSecret(pairingSecret))
  search.set(uriParams.relay, assertRelayUrl(relay, { allowPrivateNetwork }))
  search.set(uriParams.version, String(version))
  // Resolve the link base: the shared `urpc://` scheme by default, a
  // bare scheme normalized to `<scheme>://`, or a value already
  // carrying `://` (a custom scheme or full universal-link URL) used
  // verbatim.
  const base = (() => {
    if (!target) return 'urpc://'
    if (target.includes('://')) return target
    return `${target}://`
  })()
  const url = (() => {
    try {
      return new URL(base)
    } catch (cause) {
      throw new Errors.ProtocolError('`target` must be a valid scheme or URL', {
        cause: cause as Error,
      })
    }
  })()
  for (const [key, value] of search) url.searchParams.set(key, value)
  return url.toString()
}

export declare namespace buildUri {
  /** Options for {@link buildUri}. */
  type Options = {
    /**
     * Permit an HTTP `relay` on a private / link-local network for LAN
     * development. HTTPS and HTTP loopback are always allowed. Off by
     * default.
     */
    allowPrivateNetwork?: boolean | undefined
    /** Consumer's raw 32-byte X25519 public key. */
    consumerPublicKey: Hex.Hex | Bytes.Bytes
    /** 32-byte out-of-band pairing secret. */
    pairingSecret: Hex.Hex | Bytes.Bytes
    /** Relay server base URL (HTTPS, or HTTP loopback for development). */
    relay: string
    /**
     * Target of the pairing link: a bare scheme (`'example-wallet'` →
     * `example-wallet://`), a full universal link
     * (`'https://wallet.example/urpc'`), or omitted for the shared
     * `urpc://` scheme.
     */
    target?: string | undefined
  }
}

/**
 * Parse and validate an initial pairing link (§2.3.3, §2.3.4).
 *
 * Enforces the host-side receipt rules: known `version`, well-formed
 * 32-byte `consumer_pubkey` and `pairing_secret`, and an HTTPS (or
 * HTTP-loopback, for development) `relay` URL. Throws
 * {@link Errors.ProtocolError} on any violation — the host transport
 * wraps this into its public `InvalidUriError`.
 */
export function parseUri(uri: string, options: parseUri.Options = {}): parseUri.ReturnType {
  const url = (() => {
    try {
      return new URL(uri)
    } catch (cause) {
      throw new Errors.ProtocolError('pairing uri is not a valid URL', { cause: cause as Error })
    }
  })()
  const versionParam = Uri.requiredSearchParam(url, uriParams.version)
  if (versionParam === undefined)
    throw new Errors.ProtocolError('pairing uri is missing a `version` parameter')
  if (versionParam !== String(version))
    throw new Errors.ProtocolError('pairing uri has an unsupported `version`', {
      details: `received ${versionParam}, supported ${version}`,
    })
  const consumerPublicKeyParam = Uri.requiredSearchParam(url, uriParams.consumerPublicKey)
  if (consumerPublicKeyParam === undefined)
    throw new Errors.ProtocolError('pairing uri is missing a `consumer_pubkey` parameter')
  const pairingSecretParam = Uri.requiredSearchParam(url, uriParams.pairingSecret)
  if (pairingSecretParam === undefined)
    throw new Errors.ProtocolError('pairing uri is missing a `pairing_secret` parameter')
  const relayParam = Uri.requiredSearchParam(url, uriParams.relay)
  if (relayParam === undefined)
    throw new Errors.ProtocolError('pairing uri is missing a `relay` parameter')
  return {
    consumerPublicKey: Crypto.decodePublicKey(consumerPublicKeyParam),
    pairingSecret: decodeSecret(pairingSecretParam),
    relay: assertRelayUrl(relayParam, options),
    version,
  }
}

export declare namespace parseUri {
  /** Options for {@link parseUri}. */
  type Options = {
    /**
     * Permit an HTTP `relay` on a private / link-local network for LAN
     * development. HTTPS and HTTP loopback are always allowed. Off by
     * default — the relay URL arrives inside attacker-controllable link
     * material, so this would otherwise open an SSRF hole.
     */
    allowPrivateNetwork?: boolean | undefined
  }

  /** Result of {@link parseUri}. */
  type ReturnType = {
    /** Consumer's X25519 public key (hex form of the raw 32 bytes). */
    consumerPublicKey: Hex.Hex
    /** Pairing secret (hex form of the raw 32 bytes). */
    pairingSecret: Hex.Hex
    /** Relay server base URL, trailing slash removed. */
    relay: string
    /** Initial-link format version. */
    version: typeof version
  }
}

/**
 * Validate and normalize a relay base URL. HTTPS and HTTP loopback are
 * always accepted; private/link-local HTTP is accepted only when
 * {@link assertRelayUrl.Options.allowPrivateNetwork} is set (LAN testing
 * with a physical device). A query or fragment is always rejected: the
 * relay path (`/:channelId/:peer`) is appended by string concatenation,
 * so a `?`/`#` in the base would capture it — and on the host side the
 * base arrives inside attacker-controllable link material, making this
 * an SSRF-shaping vector. Rejecting public-internet HTTP closes the
 * downgrade hole the same link could otherwise open.
 *
 * @internal
 */
function assertRelayUrl(value: string, options: assertRelayUrl.Options = {}): string {
  const url = (() => {
    try {
      return new URL(value)
    } catch (cause) {
      throw new Errors.ProtocolError('relay must be a valid URL', { cause: cause as Error })
    }
  })()
  if (url.search || url.hash)
    throw new Errors.ProtocolError('relay must not contain a query or fragment', {
      details: `received ${value}`,
    })
  const allowed =
    url.protocol === 'https:' ||
    Uri.isLoopbackHttp(url) ||
    (options.allowPrivateNetwork === true && Uri.isPrivateHttp(url))
  if (!allowed)
    throw new Errors.ProtocolError(
      'relay must be an HTTPS URL (or HTTP loopback; pass `allowPrivateNetwork` for LAN development)',
      {
        details: `received ${value}`,
      },
    )
  return Uri.trimTrailingSlash(url.toString())
}

declare namespace assertRelayUrl {
  /** Options for {@link assertRelayUrl}. */
  type Options = {
    /**
     * Permit HTTP relay URLs on private / link-local networks (RFC 1918
     * ranges, `169.254/16`, `.local`) for LAN development with a physical
     * device. HTTPS and HTTP loopback are always allowed; this only
     * widens acceptance to private hosts. Off by default — the relay URL
     * arrives inside attacker-controllable link material on the host
     * side, so private-network HTTP would otherwise open an SSRF hole
     * (e.g. cloud metadata at `169.254.169.254`).
     */
    allowPrivateNetwork?: boolean | undefined
  }
}

/**
 * Create the AEAD session cipher for one keyed relay session. Owns the
 * per-direction nonce counters and the AAD/role/`from` discipline:
 *
 * - `seal` wraps a plaintext envelope into the `encrypted` wire
 *   envelope under the local role's directional key (Core §6.4).
 * - `open` verifies and unwraps an inbound `encrypted` envelope —
 *   `from` must identify the peer, the nonce must be strictly greater
 *   than the inbound high-water mark (advanced only after successful
 *   AEAD verification, Core §6.2), and an inner `encrypted` type is
 *   rejected (Core §6.1).
 */
export function createCipher(options: createCipher.Options): createCipher.ReturnType {
  const { consumerPublicKey, keys, role } = options
  const role_peer = role === 'consumer' ? 'host' : 'consumer'
  const key_open = role === 'consumer' ? keys.h2c : keys.c2h
  const key_seal = role === 'consumer' ? keys.c2h : keys.h2c
  const outbound = Nonce.encoder()
  const inbound = Nonce.decoder()

  function aad(sender: Envelope.From): Hex.Hex {
    return Aad.encode({
      publicKey: consumerPublicKey,
      role: sender === 'consumer' ? Aad.role.consumer : Aad.role.host,
    })
  }

  return {
    open(envelope) {
      if (envelope.payload.from !== role_peer)
        throw new Errors.ProtocolError('encrypted envelope `from` does not identify the peer', {
          details: `expected ${role_peer}, received ${envelope.payload.from}`,
        })
      const frame = Envelope.toEncrypted(envelope)
      if (Nonce.toCounter(frame.nonce) <= inbound.hwm)
        throw new Errors.ProtocolError('nonce not strictly greater than HWM', {
          details: `hwm=${inbound.hwm}, received counter=${Nonce.toCounter(frame.nonce)}`,
        })
      const plaintext = Aead.open({
        aad: aad(role_peer),
        ciphertext: frame.ciphertext,
        key: key_open,
        nonce: frame.nonce,
      })
      // Advance the high-water mark only after AEAD verification
      // succeeded (Core §6.2) so fabricated high-nonce frames cannot
      // burn the window for legitimate traffic.
      inbound.accept(frame.nonce)
      const inner = Envelope.parse(JSON.parse(Bytes.toString(Bytes.from(plaintext))))
      if (inner.type === 'encrypted')
        throw new Errors.ProtocolError('inner envelope type `encrypted` is forbidden')
      return inner
    },
    seal(envelope) {
      if (envelope.type === 'encrypted')
        throw new Errors.ProtocolError('inner envelope type `encrypted` is forbidden')
      const nonce = outbound.next()
      const ciphertext = Aead.seal({
        aad: aad(role),
        key: key_seal,
        nonce,
        plaintext: Bytes.fromString(JSON.stringify(envelope)),
      })
      return Envelope.encrypted({ ciphertext, from: role, nonce })
    },
  }
}

export declare namespace createCipher {
  /** Options for {@link createCipher}. */
  type Options = {
    /** Consumer's raw 32-byte X25519 public key (the session anchor, AAD-bound). */
    consumerPublicKey: Hex.Hex | Bytes.Bytes
    /** Per-direction AEAD keys from {@link "../core/Session".derive}. */
    keys: Session.derive.ReturnType
    /** Local role this cipher seals for. */
    role: Envelope.From
  }

  /** Result of {@link createCipher}. */
  type ReturnType = {
    /** Verify and unwrap an inbound `encrypted` envelope into its plaintext envelope. */
    open: (envelope: Extract<Envelope.Envelope, { type: 'encrypted' }>) => Envelope.Envelope
    /** Seal a plaintext envelope into an `encrypted` wire envelope. */
    seal: (envelope: Envelope.Envelope) => Extract<Envelope.Envelope, { type: 'encrypted' }>
  }
}

/**
 * Create the signed HTTP channel one peer holds onto a relay server:
 * RFC 9421-signed POSTs to the *other* peer's slot and a signed,
 * auto-reconnecting SSE subscription on the *own* slot (spec §§4–6).
 *
 * Every request carries (and covers) `uRPC-Public-Key` — required on
 * the first-registration request, tolerated afterwards since it always
 * matches the registered key — plus `created`, a random `nonce`, and
 * `keyid = channel_id`.
 */
export function createChannel(options: createChannel.Options): createChannel.ReturnType {
  const {
    allowPrivateNetwork,
    channelId: id,
    fetch: fetchImpl,
    keypair,
    peer,
    pollInterval = pollIntervalDefault,
    receive = 'sse',
    url,
  } = options
  // Validate + normalize the relay URL up front, before any request is
  // signed or sent — so an invalid/insecure `url` fails the channel's
  // construction rather than mid-subscription.
  const base = assertRelayUrl(url, { allowPrivateNetwork })
  const peer_target = peer === 'consumer' ? 'host' : 'consumer'

  // Requests are issued as `fetch(url, init)` — never `fetch(Request)` —
  // so narrower WinterCG-style fetch implementations (e.g. `expo/fetch`,
  // which streams but does not take `Request` inputs) drop in via the
  // `fetch` option unchanged.
  function signed(parameters: {
    accept?: string | undefined
    body?: string | undefined
    extraComponents?: readonly string[] | undefined
    method: string
    signal?: AbortSignal | undefined
    url: string
  }): { init: RequestInit; url: string } {
    const { accept, body, extraComponents, method, signal, url: requestUrl } = parameters
    const headers: Record<string, string> = {
      'urpc-public-key': Crypto.encodePublicKey(keypair.publicKey),
    }
    if (accept) headers['accept'] = accept
    if (body !== undefined) {
      headers['content-digest'] = MessageSig.contentDigest(body)
      headers['content-type'] = 'application/json'
    }
    const components = ['@method', '@path', '@authority']
    if (body !== undefined) components.push('content-digest')
    components.push('urpc-public-key')
    if (extraComponents) components.push(...extraComponents)
    const { signature, signatureInput } = MessageSig.sign({
      components,
      message: { headers, method, url: requestUrl },
      parameters: {
        alg: 'ed25519',
        created: Math.floor(Date.now() / 1000),
        keyid: id,
        nonce: Base64.fromBytes(Bytes.random(16), { pad: false, url: true }),
      },
      privateKey: keypair.privateKey,
    })
    headers['signature'] = signature
    headers['signature-input'] = signatureInput
    return {
      init: {
        headers,
        method,
        ...(body === undefined ? {} : { body }),
        ...(signal === undefined ? {} : { signal }),
      },
      url: requestUrl,
    }
  }

  return {
    async post(body) {
      const request = signed({ body, method: 'POST', url: `${base}/${id}/${peer_target}` })
      const response = await fetchImpl(request.url, request.init)
      if (response.status === 202) return 'delivered'
      if (response.status === 204) return 'dropped'
      throw new HttpError(`relay POST failed with status ${response.status}`, response.status)
    },
    async subscribe(parameters) {
      const { onClose, onError, onEvent, signal } = parameters
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      signal.addEventListener('abort', () => {
        void reader?.cancel().catch(() => undefined)
      })

      // Short-poll fallback (spec §5.3): repeatedly issue signed GETs
      // with `wait=0` so each request returns instantly — `200` + body
      // when a message is queued, `204` when the slot is empty, or `409`
      // when the slot is superseded (treated like the SSE `closed`
      // event → reconnect). No request is ever held open, so proxies and
      // mobile networks can't stall on a long-lived connection. After an
      // empty `204` the client sleeps `pollInterval` ms before polling
      // again; after a `200` it polls again immediately to drain any
      // backlog. Gaps between polls rely on the relay's optional
      // buffering (spec §5.4) to avoid dropping the peer's messages.
      async function connectPoll(onOpen: (() => void) | undefined): Promise<void> {
        while (!signal.aborted) {
          const request = signed({
            accept: 'application/json',
            extraComponents: ['@query-param;name="wait"'],
            method: 'GET',
            signal,
            url: `${base}/${id}/${peer}?wait=0`,
          })
          const response = await fetchImpl(request.url, request.init)
          if (response.status === 409) return
          if (response.status !== 200 && response.status !== 204)
            throw new HttpError(`relay poll failed with status ${response.status}`, response.status)
          if (onOpen) {
            onOpen()
            onOpen = undefined
          }
          if (response.status === 200) {
            onEvent(await response.text())
            continue
          }
          await sleep(pollInterval, signal)
        }
      }

      async function connectSse(onOpen: (() => void) | undefined): Promise<void> {
        const request = signed({
          accept: 'text/event-stream',
          method: 'GET',
          signal,
          url: `${base}/${id}/${peer}`,
        })
        const response = await fetchImpl(request.url, request.init)
        if (response.status !== 200 || !response.body)
          throw new HttpError(
            `relay subscription failed with status ${response.status}`,
            response.status,
          )
        reader = response.body.getReader()
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined)
          reader = undefined
          return
        }
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let index = buffer.indexOf('\n\n')
            while (index >= 0) {
              const block = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              index = buffer.indexOf('\n\n')
              const event = parseSseBlock(block)
              if (!event) continue
              if (onOpen) {
                onOpen()
                onOpen = undefined
              }
              // `closed` = server-initiated stream closure (shutdown,
              // GC, supersession) — end this connection and let the
              // reconnect loop re-subscribe.
              if (event.event === 'closed') return
              if (event.event === 'message') onEvent(event.data)
            }
          }
        } finally {
          reader = undefined
        }
      }

      const connect = receive === 'poll' ? connectPoll : connectSse

      return new Promise<void>((resolve, reject) => {
        void (async () => {
          let attempt = 0
          let opened = false
          while (!signal.aborted) {
            try {
              await connect(() => {
                attempt = 0
                opened = true
                resolve()
              })
            } catch (error) {
              // The first connection's failure belongs to the caller —
              // surface it through the returned promise.
              if (!opened) {
                reject(error as Error)
                return
              }
              if (signal.aborted) break
              // 4xx (other than 429) won't heal on retry — give up and
              // hand the cause to the owner.
              if (error instanceof HttpError && error.terminal) {
                onClose?.(error)
                return
              }
              onError?.(error as Error)
            }
            if (signal.aborted) break
            attempt = Math.min(attempt + 1, 5)
            await sleep(250 * 2 ** attempt * (0.5 + Math.random() / 2), signal)
          }
          onClose?.()
          // Aborted before the first event — settle the caller's
          // promise so a concurrent `close()` cannot strand `start()`.
          reject(new Transport.ClosedError('relay subscription ended before opening'))
        })()
      })
    },
  }
}

export declare namespace createChannel {
  /** Options for {@link createChannel}. */
  type Options = {
    /**
     * Permit an HTTP relay `url` on a private / link-local network for
     * LAN development. HTTPS and HTTP loopback are always allowed. Off
     * by default.
     */
    allowPrivateNetwork?: boolean | undefined
    /** Channel identifier from {@link channelId}. */
    channelId: string
    /** `fetch` implementation carrying both POSTs and the SSE stream. */
    fetch: typeof globalThis.fetch
    /** Local ephemeral Ed25519 keypair signing every relay request. */
    keypair: { privateKey: Hex.Hex; publicKey: Hex.Hex }
    /** Local peer slot — subscribes this slot, POSTs to the other. */
    peer: Envelope.From
    /**
     * Gap, in milliseconds, between successive `'poll'` receive requests
     * after an empty response. Defaults to `2000`. Ignored when
     * `receive` is `'sse'`.
     */
    pollInterval?: number | undefined
    /**
     * Receive transport for the own-slot subscription: `'sse'` (default,
     * a single long-lived `text/event-stream` connection) or `'poll'`
     * (short polling — repeated instant `application/json` GETs with
     * `wait=0`, spec §5.3, for environments where SSE is unreliable).
     * Polling pairs best with a relay that enables buffering (spec §5.4),
     * since brief gaps between polls would otherwise drop the peer's
     * messages.
     */
    receive?: 'poll' | 'sse' | undefined
    /** Relay server base URL. */
    url: string
  }

  /** Result of {@link createChannel}. */
  type ReturnType = {
    /**
     * Send one verbatim body to the other peer's slot. Resolves
     * `'delivered'` on HTTP 202, `'dropped'` on 204 (no active
     * receiver — the relay is not a queue); throws {@link HttpError}
     * on anything else.
     */
    post: (body: string) => Promise<'delivered' | 'dropped'>
    /**
     * Open the signed SSE subscription on the own peer slot. Resolves
     * once the first connection delivers an event (normally `opened`),
     * then keeps reading — reconnecting with jittered backoff — until
     * `signal` aborts (→ `onClose()`) or the relay rejects terminally
     * (→ `onClose(cause)`). Rejects if the *first* connection fails.
     */
    subscribe: (parameters: {
      /** Called once when the subscription permanently ends. */
      onClose?: ((cause?: Error) => void) | undefined
      /** Called on recoverable reconnect errors. */
      onError?: ((error: Error) => void) | undefined
      /** Called with each verbatim `message` event body. */
      onEvent: (data: string) => void
      /** Abort to end the subscription (and any backoff sleep). */
      signal: AbortSignal
    }) => Promise<void>
  }
}

/** Parse one SSE block (`event:` / `data:` lines) into its event and data. */
function parseSseBlock(block: string): { data: string; event: string } | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon)
    const value = line.startsWith(' ', colon + 1) ? line.slice(colon + 2) : line.slice(colon + 1)
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
  }
  if (data.length === 0) return undefined
  return { data: data.join('\n'), event }
}

/** Abort-aware sleep used by the subscription's reconnect backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

/**
 * Thrown when the relay answers a request with an unexpected HTTP
 * status. `terminal` discriminates statuses that cannot heal on retry
 * (4xx other than 429) from transient ones (429, 5xx, network).
 */
export class HttpError extends Transport.TransportError {
  override name = 'Relay.HttpError'

  /** HTTP status returned by the relay. */
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }

  /** True when retrying cannot succeed (4xx other than 429). */
  get terminal(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }
}
