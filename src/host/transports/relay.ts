/**
 * Host-side `relay` transport — end-to-end-encrypted, ongoing session
 * with a consumer through a stateless HTTPS relay.
 *
 * Implements the host half of the uRPC `relay` transport spec. The
 * transport pairs from the uri the consumer delivered out-of-band (QR
 * scan, deep link) — one pairing, one transport, one session; relay
 * sessions are never resumed.
 *
 * The pairing uri can arrive at construction (`relay({ uri })`, pinned
 * and validated eagerly) or asynchronously at start time
 * (`wata.relay.start({ pairingUri })`), so a single hoisted
 * `Wata.create({ transports: [relay()] })` can be paired once a link is
 * scanned. The pairing queue lives inside the transport — no external
 * source object to wire up.
 *
 * `start()` subscribes the host's relay slot, proves possession of the
 * out-of-band `pairing_secret` with the `hello` message's `host_proof`,
 * and resolves once the consumer's encrypted `ready` frame confirms
 * both sides derived the same keys — `await wata.relay.start({
 * pairingUri })` means "connected". From then on `rpc-requests` /
 * `rpc-responses` envelopes flow sealed end-to-end; the relay only ever
 * sees ciphertext.
 *
 * @example
 * ```ts
 * import { Wata, relay } from 'wata/host'
 *
 * const wata = Wata.create({ transports: [relay()] })
 *
 * wata.on('request', async (event) => {
 *   if (event.method === 'wallet_connect') await event.respond({ accounts })
 * })
 *
 * // `pairingUri` delivered by QR scan / deep link:
 * // urpc://?version=1&consumer_pubkey=...&pairing_secret=...&relay=...
 * await wata.relay.start({ pairingUri }) // resolves once the session is keyed
 * ```
 */

import { Base64, Bytes } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Session from '../../core/Session.js'
import * as Transport from '../../core/Transport.js'
import * as Relay from '../../internal/Relay.js'

/** Options accepted by {@link relay}. */
export type Options = {
  /**
   * Permit an HTTP relay on a private / link-local network (RFC 1918,
   * `169.254/16`, `.local`) when parsing the consumer's pairing link,
   * for LAN development with a physical device. HTTPS and HTTP loopback
   * are always allowed. Off by default — the relay URL arrives inside
   * the attacker-controllable pairing link, so private-network HTTP
   * would otherwise open an SSRF hole (e.g. cloud metadata at
   * `169.254.169.254`).
   */
  allowPrivateNetwork?: boolean | undefined
  /**
   * Handshake window in milliseconds: how long `start()` waits for the
   * consumer's encrypted `ready` confirmation before rejecting with
   * {@link PairingExpiredError}. Defaults to 300_000 (5 minutes).
   */
  expiresIn?: number | undefined
  /**
   * Override the `fetch` implementation carrying the SSE subscription
   * and POSTs. Defaults to `globalThis.fetch`. Useful for tests and
   * in-process relays.
   */
  fetch?: typeof globalThis.fetch | undefined
  /**
   * Gap, in milliseconds, between successive `receive: 'poll'` requests
   * after an empty response. Defaults to `2000`. Ignored when `receive`
   * is `'sse'`.
   */
  pollInterval?: number | undefined
  /**
   * Receive transport for inbound messages: `'sse'` (default, a single
   * long-lived `text/event-stream` connection) or `'poll'` (short
   * polling — repeated instant `application/json` GETs with `wait=0`
   * every ~2s, spec §5.3) for environments where SSE is unreliable
   * (restrictive proxies, some mobile runtimes). Polling pairs best with
   * a relay that enables buffering (spec §5.4).
   */
  receive?: 'poll' | 'sse' | undefined
  /**
   * Pairing link delivered by the consumer (QR scan, deep link). When
   * supplied, it is parsed and validated at construction time, throwing
   * {@link InvalidUriError} on malformed links so scan-routing code
   * fails fast.
   *
   * Omit it to supply the link at start time instead via
   * `wata.relay.start({ pairingUri })`, so a single hoisted
   * `Wata.create({ transports: [relay()] })` can be paired once a link
   * is scanned.
   */
  uri?: string | undefined
}

/**
 * Parse and validate a relay pairing uri. Use it to route scanned QR
 * payloads ("is this a relay pairing link?") without constructing a
 * transport. Throws {@link InvalidUriError} when the value is not a
 * valid `version=1` relay link.
 *
 * @example
 * ```ts
 * import { Relay } from 'wata/host'
 *
 * const { relay: relayUrl } = Relay.parseUri(scanned)
 * ```
 */
export function parseUri(uri: string, options: parseUri.Options = {}): Relay.parseUri.ReturnType {
  try {
    return Relay.parseUri(uri, options)
  } catch (cause) {
    throw new InvalidUriError('value is not a valid relay pairing uri', {
      cause: cause as Error,
    })
  }
}

export declare namespace parseUri {
  /** Options for {@link parseUri}. */
  type Options = Relay.parseUri.Options
}

/**
 * Create a host-side `relay` transport.
 *
 * @example
 * ```ts
 * import { relay } from 'wata/host'
 *
 * const transport = relay({ uri })
 * ```
 */
export function relay(options: Options = {}): relay.ReturnType {
  const {
    allowPrivateNetwork,
    expiresIn = 300_000,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    pollInterval,
    receive = 'sse',
    uri,
  } = options

  // Internal pairing queue. The uri can arrive at construction (pinned
  // + validated eagerly below) or at start time via
  // `start({ pairingUri })`; either way it flows through `publishPairing`
  // and is awaited by `nextPairing` once `start()` runs. Keeping the
  // queue inside the transport means callers never wire up an external
  // pairing source.
  type PairingPending = { reject: (error: Error) => void; resolve: (uri: string) => void }
  let pairingPending: PairingPending | undefined
  let pairingQueued: string | undefined

  function publishPairing(uri: string) {
    parseUri(uri, { allowPrivateNetwork })
    if (pairingPending) {
      const { resolve } = pairingPending
      pairingPending = undefined
      resolve(uri)
    } else pairingQueued = uri
  }

  function nextPairing(signal: AbortSignal): Promise<string> {
    if (pairingQueued !== undefined) {
      const next = pairingQueued
      pairingQueued = undefined
      return Promise.resolve(next)
    }
    return new Promise<string>((resolve, reject) => {
      const fail = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Transport.ClosedError('relay transport closed before pairing'),
        )
      if (signal.aborted) return fail()
      pairingPending = { reject, resolve }
      signal.addEventListener(
        'abort',
        () => {
          if (!pairingPending) return
          pairingPending = undefined
          fail()
        },
        { once: true },
      )
    })
  }

  // Pin + validate a construction-time uri eagerly so scan-routing
  // fails fast; it is queued for the first `start()` to consume.
  if (typeof uri === 'string') publishPairing(uri)

  const emitter = Events.create<Transport.EventMap>()

  // `phase` tracks the host-side handshake: `handshake` until the
  // consumer's encrypted `ready` decrypts cleanly (spec §6.7, §10.9),
  // then `keyed`. Application envelopes inbound before `ready` are a
  // protocol violation; outbound sends buffer until keyed.
  type State = { phase: 'handshake' | 'keyed'; started: boolean }
  const state: State = { phase: 'handshake', started: false }
  let abort: AbortController | undefined
  let buffered: Envelope.Envelope[] = []
  let channel: Relay.createChannel.ReturnType | undefined
  let cipher: Relay.createCipher.ReturnType | undefined
  let readyReject: ((error: Error) => void) | undefined
  let readyResolve: (() => void) | undefined
  let startPromise: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function emitError(error: Error) {
    emitter.emit('error', error)
  }

  function reset() {
    state.started = false
    state.phase = 'handshake'
    buffered = []
    channel = undefined
    cipher = undefined
    readyReject = undefined
    readyResolve = undefined
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    abort?.abort()
    abort = undefined
  }

  function emitClose(cause?: Error) {
    if (!state.started) return
    reset()
    emitter.emit('close', cause)
  }

  function teardown(error: Error) {
    emitError(error)
    if (readyReject) {
      // Still handshaking — fail the in-flight `start()` instead of
      // emitting `close` for a session that never opened.
      const reject = readyReject
      readyReject = undefined
      reject(error)
      return
    }
    emitClose(error)
  }

  /** POST one verbatim body, retrying short receiver gaps. */
  async function post(body: string): Promise<void> {
    if (!channel) throw new Transport.ClosedError('relay session is not started')
    for (let attempt = 0; ; attempt++) {
      const result = await channel.post(body)
      if (result === 'delivered') return
      if (attempt >= 2)
        throw new Transport.TransportError(
          'consumer has no active relay receiver (message dropped)',
        )
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  async function deliver(envelope: Envelope.Envelope): Promise<void> {
    if (!cipher) throw new Transport.ClosedError('relay session is not keyed')
    await post(JSON.stringify(cipher.seal(envelope)))
  }

  function handleEvent(data: string) {
    let envelope: Envelope.Envelope
    try {
      envelope = Envelope.parse(JSON.parse(data))
    } catch (error) {
      emitError(error as Error)
      return
    }
    // Mode discipline (spec §6.7): after the host has sent `hello`,
    // every inbound message must be `encrypted`.
    if (envelope.type !== 'encrypted') {
      teardown(
        new Errors.ProtocolError('only `encrypted` envelopes are permitted on the relay host', {
          details: `received ${envelope.type}`,
        }),
      )
      return
    }
    if (!cipher) return
    let inner: Envelope.Envelope
    try {
      inner = cipher.open(envelope)
    } catch (error) {
      // Replays / duplicates / undecryptable frames are rejected per
      // envelope; a consumer that misderived keys simply never
      // confirms and the handshake times out.
      emitError(error as Error)
      return
    }
    if (state.phase === 'handshake') {
      // Explicit mutual key confirmation (spec §6.5, §10.9): the
      // consumer's first envelope MUST be `ready` — refuse to process
      // application traffic before it.
      if (inner.type !== 'ready') {
        teardown(
          new Errors.ProtocolError('first envelope must be `ready`', {
            details: `received ${inner.type}`,
          }),
        )
        return
      }
      state.phase = 'keyed'
      state.started = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      readyResolve?.()
      const queue = buffered
      buffered = []
      void (async () => {
        for (const queued of queue) {
          try {
            await deliver(queued)
          } catch (error) {
            emitError(error as Error)
          }
        }
      })()
      return
    }
    if (inner.type !== 'rpc-requests' && inner.type !== 'rpc-responses') return
    emitter.emit('message', inner)
  }

  async function start(options: relay.StartOptions = {}): Promise<void> {
    if (options.pairingUri !== undefined) publishPairing(options.pairingUri)
    if (state.started) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      const controller = new AbortController()
      abort = controller
      try {
        const parsed = parseUri(await nextPairing(controller.signal), { allowPrivateNetwork })
        const keypair = Crypto.randomKeypair()
        const sharedSecret = Session.shared({
          privateKey: keypair.x25519.privateKey,
          publicKey: parsed.consumerPublicKey,
        })
        const proof = Relay.hostProof({
          consumerPublicKey: parsed.consumerPublicKey,
          hostPublicKey: keypair.x25519.publicKey,
          pairingSecret: parsed.pairingSecret,
          sharedSecret,
        })
        const keys = Session.derive({
          peer: { publicKey: parsed.consumerPublicKey },
          role: 'host',
          self: keypair.x25519,
          transportContext: parsed.pairingSecret,
          transportId: Relay.transportId,
        })
        cipher = Relay.createCipher({
          consumerPublicKey: parsed.consumerPublicKey,
          keys,
          role: 'host',
        })
        channel = Relay.createChannel({
          allowPrivateNetwork,
          channelId: Relay.channelId({
            consumerPublicKey: parsed.consumerPublicKey,
            pairingSecret: parsed.pairingSecret,
          }),
          fetch: fetchImpl,
          keypair,
          peer: 'host',
          pollInterval,
          receive,
          url: parsed.relay,
        })
        const ready = new Promise<void>((resolve, reject) => {
          readyReject = reject
          readyResolve = resolve
        })
        await channel.subscribe({
          onClose: (cause) => {
            if (state.started) emitClose(cause)
            else
              readyReject?.(
                cause ?? new Transport.ClosedError('relay subscription closed during handshake'),
              )
          },
          onError: emitError,
          onEvent: handleEvent,
          signal: controller.signal,
        })
        await post(
          JSON.stringify(
            Envelope.hello({
              host_proof: Base64.fromBytes(Bytes.from(proof), { pad: false, url: true }),
              host_pubkey: Crypto.encodePublicKey(keypair.x25519.publicKey),
            }),
          ),
        )
        timer = setTimeout(() => {
          readyReject?.(
            new PairingExpiredError('consumer did not confirm the session within the window'),
          )
        }, expiresIn)
        await ready
      } catch (error) {
        reset()
        throw error
      } finally {
        readyReject = undefined
        readyResolve = undefined
        startPromise = undefined
      }
    })()
    return startPromise
  }

  return {
    capabilities: {
      notifications: { consumer: true, host: true },
      requests: { consumer: true, host: false },
    },
    async close(cause) {
      if (state.started) {
        emitClose(cause)
        return
      }
      // Close during the handshake — fail the in-flight `start()`.
      readyReject?.(cause ?? new Transport.ClosedError('relay transport closed'))
      abort?.abort()
    },
    exchange: 'ongoing',
    name: 'relay',
    on: emitter.on,
    role: 'host',
    async send(envelope) {
      if (state.phase !== 'keyed') {
        buffered.push(envelope)
        if (!state.started && !startPromise) void start().catch(emitError)
        return
      }
      await deliver(envelope)
    },
    start,
  }
}

/**
 * Thrown by {@link parseUri} / {@link relay} when the supplied value is
 * not a valid `version=1` relay pairing uri.
 */
export class InvalidUriError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'Relay.InvalidUriError'
}

/**
 * Thrown (rejecting `start()`) when the consumer did not deliver its
 * encrypted `ready` confirmation within {@link Options.expiresIn}.
 */
export class PairingExpiredError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'Relay.PairingExpiredError'
}

export declare namespace relay {
  /** Options for the relay transport's {@link Transport.Transport.start | start}. */
  type StartOptions = {
    /**
     * Pairing link delivered by the consumer (QR scan, deep link),
     * supplied at start time. Validated when published, throwing
     * {@link InvalidUriError} on malformed links. Equivalent to passing
     * {@link Options.uri} at construction; reach for it on a hoisted
     * `Wata.create({ transports: [relay()] })` once a link is scanned:
     * `await wata.relay.start({ pairingUri })`.
     */
    pairingUri?: string | undefined
  }

  /**
   * Return type of {@link relay}. A standard host `relay` transport
   * whose `start` additionally accepts a {@link StartOptions} so the
   * pairing uri can be supplied at start time.
   */
  type ReturnType = Transport.Transport<'host', 'relay'> & {
    start: (options?: StartOptions) => Promise<void>
  }
}
