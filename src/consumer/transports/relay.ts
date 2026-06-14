/**
 * Consumer-side `relay` transport — end-to-end-encrypted, ongoing
 * session with a host through a stateless HTTPS relay.
 *
 * Implements the consumer half of the uRPC `relay` transport spec. On
 * `start()` the transport generates fresh bootstrap material (ephemeral
 * keypair + 32-byte `pairing_secret`), locks its relay slot over a
 * signed SSE subscription, and surfaces the pairing link via the
 * `'prompt'` event — render it as a QR code or deep link for the host
 * device. Once the host's `hello` arrives, the transport
 * verifies `host_proof` in constant time, derives the per-direction
 * AEAD keys, confirms with an encrypted `ready` frame, and from then on
 * carries `rpc-requests` / `rpc-responses` envelopes sealed end-to-end —
 * the relay only ever sees ciphertext.
 *
 * Outbound envelopes sent before the session is keyed are buffered and
 * flushed after `ready`, so `wata.send(...)` can be called immediately —
 * it resolves once the host answers.
 *
 * @example
 * ```ts
 * import { Wata, relay } from 'wata'
 *
 * const wata = Wata.create({
 *   transports: [relay({ url: 'https://relay.example' })],
 * })
 *
 * // Render the pairing link out-of-band (QR code, deep link, …).
 * wata.on('prompt', ({ uri }) => renderQrCode(uri))
 *
 * const { result } = await wata.send({ method: 'wallet_connect', params: [] })
 * ```
 */

import { Base64, Bytes, Hex } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Session from '../../core/Session.js'
import * as Transport from '../../core/Transport.js'
import * as Relay from '../../internal/Relay.js'

/** Pairing information carried by the consumer `'prompt'` event. */
export type Prompt = {
  /** Epoch-ms instant at which the pairing window closes. */
  expiresAt: number
  /** Initial pairing link to deliver out-of-band (QR code, deep link). */
  uri: string
}

/** Options accepted by {@link relay}. */
export type Options = {
  /**
   * Pairing window in milliseconds: how long to wait for the host's
   * `hello` before failing closed with {@link PairingExpiredError}.
   * Defaults to 300_000 (the spec-recommended 5 minutes).
   */
  expiresIn?: number | undefined
  /**
   * Override the `fetch` implementation carrying the SSE subscription
   * and POSTs. Defaults to `globalThis.fetch`. Useful for tests and
   * in-process relays.
   */
  fetch?: typeof globalThis.fetch | undefined
  /**
   * Universal-link base of the target host (e.g.
   * `https://wallet.example/urpc`). When set, the pairing link opens
   * the host app directly; when omitted, the shared `urpc://` scheme
   * is used for any-host flows.
   */
  host?: string | undefined
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
  /** Relay server base URL (HTTPS, or HTTP loopback for development). */
  url: string
}

/**
 * Create a consumer-side `relay` transport.
 *
 * @example
 * ```ts
 * import { relay } from 'wata'
 *
 * const transport = relay({ url: 'https://relay.example' })
 * ```
 */
export function relay(
  options: Options,
): Transport.Transport<'consumer', 'relay', void, Transport.NoMessageMeta, Prompt> {
  const {
    expiresIn = 300_000,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    host,
    pollInterval,
    receive = 'sse',
    url,
  } = options

  const emitter = Events.create<Transport.EventMap<Transport.NoMessageMeta, Prompt>>()

  // `started` = currently in an active session cycle. After close it
  // drops back to `false` and the next `start()` generates fresh
  // bootstrap material — a relay session is never resumed (spec §7.3).
  type State = { phase: 'pre-key' | 'keyed'; started: boolean }
  const state: State = { phase: 'pre-key', started: false }
  let abort: AbortController | undefined
  let buffered: Envelope.Envelope[] = []
  let channel: Relay.createChannel.ReturnType | undefined
  let cipher: Relay.createCipher.ReturnType | undefined
  let keypair: Crypto.Keypair | undefined
  let pairingSecret: Hex.Hex | undefined
  let startPromise: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function emitError(error: Error) {
    emitter.emit('error', error)
  }

  function emitClose(cause?: Error) {
    if (!state.started) return
    state.started = false
    state.phase = 'pre-key'
    buffered = []
    channel = undefined
    cipher = undefined
    keypair = undefined
    pairingSecret = undefined
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    abort?.abort()
    abort = undefined
    emitter.emit('close', cause)
  }

  function teardown(error: Error) {
    emitError(error)
    emitClose(error)
  }

  /** Seal and POST one envelope, retrying short `dropped` gaps. */
  async function deliver(envelope: Envelope.Envelope): Promise<void> {
    if (!channel || !cipher) throw new Transport.ClosedError('relay session is not keyed')
    const body = JSON.stringify(cipher.seal(envelope))
    for (let attempt = 0; ; attempt++) {
      const result = await channel.post(body)
      if (result === 'delivered') return
      if (attempt >= 2)
        throw new Transport.TransportError('host has no active relay receiver (message dropped)')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  function handleHello(envelope: Extract<Envelope.Envelope, { type: 'hello' }>) {
    if (!keypair || !pairingSecret || !channel)
      throw new Errors.ProtocolError('relay session is not started')
    const payload = envelope.payload as Record<string, unknown>
    if (typeof payload['host_pubkey'] !== 'string' || typeof payload['host_proof'] !== 'string')
      throw new Errors.ProtocolError('hello payload must carry `host_pubkey` and `host_proof`')
    const hostPublicKey = Crypto.decodePublicKey(payload['host_pubkey'])
    const proof = (() => {
      try {
        const bytes = Base64.toBytes(payload['host_proof'])
        if (bytes.length !== 32) throw new Error('expected 32 bytes')
        return bytes
      } catch (cause) {
        throw new Errors.ProtocolError('hello `host_proof` must be 32-byte unpadded base64url', {
          cause: cause as Error,
        })
      }
    })()
    const sharedSecret = Session.shared({
      privateKey: keypair.x25519.privateKey,
      publicKey: hostPublicKey,
    })
    const expected = Relay.hostProof({
      consumerPublicKey: keypair.x25519.publicKey,
      hostPublicKey,
      pairingSecret,
      sharedSecret,
    })
    // Spec §8.2/§10.3: fail closed locally on proof mismatch — no
    // structured peer-visible error before the encrypted channel exists.
    if (!constantTimeEqual(proof, Bytes.from(expected)))
      throw new PairingFailedError('host proof verification failed')
    const keys = Session.derive({
      peer: { publicKey: hostPublicKey },
      role: 'consumer',
      self: keypair.x25519,
      transportContext: pairingSecret,
      transportId: Relay.transportId,
    })
    cipher = Relay.createCipher({
      consumerPublicKey: keypair.x25519.publicKey,
      keys,
      role: 'consumer',
    })
    state.phase = 'keyed'
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    // Mutual key confirmation (spec §6.5): the encrypted `ready` frame
    // MUST be the consumer's first envelope, before any buffered
    // application traffic flushes.
    void (async () => {
      try {
        await deliver(Envelope.ready())
      } catch (error) {
        teardown(error as Error)
        return
      }
      const queue = buffered
      buffered = []
      for (const queued of queue) {
        try {
          await deliver(queued)
        } catch (error) {
          emitError(error as Error)
        }
      }
    })()
  }

  function handleEvent(data: string) {
    let envelope: Envelope.Envelope
    try {
      envelope = Envelope.parse(JSON.parse(data))
    } catch (error) {
      emitError(error as Error)
      return
    }
    // Mode discipline (Core §7.5, relay §6.7): exactly one plaintext
    // `hello` pre-key; nothing but `encrypted` after. Violations tear
    // the session down.
    if (state.phase === 'pre-key') {
      if (envelope.type !== 'hello') {
        teardown(
          new Errors.ProtocolError('only `hello` is permitted before key derivation', {
            details: `received ${envelope.type}`,
          }),
        )
        return
      }
      try {
        handleHello(envelope)
      } catch (error) {
        teardown(error as Error)
      }
      return
    }
    if (envelope.type !== 'encrypted') {
      teardown(
        new Errors.ProtocolError('only `encrypted` envelopes are permitted after key derivation', {
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
      // Replays / duplicates / tampered ciphertext are rejected per
      // envelope — the relay may duplicate frames, so this is not a
      // session-fatal condition.
      emitError(error as Error)
      return
    }
    if (inner.type !== 'rpc-requests' && inner.type !== 'rpc-responses') return
    emitter.emit('message', inner)
  }

  async function start(): Promise<void> {
    if (state.started) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        const keypair_local = Crypto.randomKeypair()
        const pairingSecret_local = Hex.fromBytes(Bytes.random(32))
        const controller = new AbortController()
        const channel_local = Relay.createChannel({
          channelId: Relay.channelId({
            consumerPublicKey: keypair_local.x25519.publicKey,
            pairingSecret: pairingSecret_local,
          }),
          fetch: fetchImpl,
          keypair: keypair_local,
          peer: 'consumer',
          pollInterval,
          receive,
          url,
        })
        // Expose the controller before subscribing so a concurrent
        // `close()` can cancel an in-flight `start()`.
        abort = controller
        // Lock the consumer slot before publishing the link (spec
        // §2.3.3) — squatters cannot register the slot once we hold it.
        await channel_local.subscribe({
          onClose: (cause) => emitClose(cause),
          onError: emitError,
          onEvent: handleEvent,
          signal: controller.signal,
        })
        channel = channel_local
        keypair = keypair_local
        pairingSecret = pairingSecret_local
        state.started = true
        timer = setTimeout(() => {
          if (state.phase !== 'keyed')
            emitClose(new PairingExpiredError('host did not connect within the pairing window'))
        }, expiresIn)
        const uri = Relay.buildUri({
          consumerPublicKey: keypair_local.x25519.publicKey,
          host,
          pairingSecret: pairingSecret_local,
          relay: url,
        })
        emitter.emit('prompt', { expiresAt: Date.now() + expiresIn, uri })
      } finally {
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
      if (!state.started) {
        // Close during an in-flight `start()` — abort the subscription
        // so the pending `start()` settles instead of opening a session.
        abort?.abort()
        abort = undefined
        return
      }
      emitClose(cause)
    },
    exchange: 'ongoing',
    name: 'relay',
    on: emitter.on,
    role: 'consumer',
    async send(envelope) {
      if (!state.started) await start()
      if (state.phase !== 'keyed') {
        buffered.push(envelope)
        return
      }
      await deliver(envelope)
    },
    start,
  }
}

/** Constant-time byte-sequence comparison for `host_proof` (spec §10.3). */
function constantTimeEqual(a: Bytes.Bytes, b: Bytes.Bytes): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= (a[index] as number) ^ (b[index] as number)
  return diff === 0
}

/**
 * Thrown (via the `close` cause) when the host did not connect and
 * confirm within {@link Options.expiresIn}. Start a fresh session —
 * pairing links are single-use.
 */
export class PairingExpiredError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'Relay.PairingExpiredError'
}

/**
 * Thrown when the host's `hello` carried a `host_proof` that does not
 * verify under the session's `pairing_secret` — a relay (or link
 * thief) attempting to substitute its own key. The session fails
 * closed without sending the peer anything (spec §8.2).
 */
export class PairingFailedError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.ProtocolError<cause> {
  override name = 'Relay.PairingFailedError'
}
