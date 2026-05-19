/**
 * Shared HTTP relay client used by the consumer and host relay transports.
 */

import * as Crypto from '../Crypto.js'
import * as Errors from '../Errors.js'
import * as Events from '../Events.js'
import * as MessageSig from '../MessageSig.js'
import * as Session from '../Session.js'
import * as Transport from '../Transport.js'
import * as Relay from './relay.js'
import * as SecureChannel from './secureChannel.js'

const header = {
  publicKey: 'urpc-public-key',
  recipient: 'urpc-recipient',
  session: 'urpc-session',
} as const

const getComponents = [
  '@method',
  '@target-uri',
  header.publicKey,
  header.recipient,
  header.session,
] as const

const postComponents = [
  '@method',
  '@target-uri',
  'content-digest',
  'content-type',
  header.publicKey,
  header.recipient,
  header.session,
] as const

/** Create a role-specific relay transport. */
export function create<const role extends Relay.Role>(
  options: create.Options<role>,
): Transport.Transport<role, 'relay'> {
  const emitter = Events.create<Transport.EventMap>()
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const role = options.role
  const role_peer = Relay.peerRole(role)
  const state: State = {
    channel: undefined,
    closed: false,
    keypair: undefined,
    polling: false,
    ready: false,
    readyReject: undefined,
    readyResolve: undefined,
    started: false,
  }
  let pollController: AbortController | undefined
  let startPromise: Promise<void> | undefined

  async function endpoint(): Promise<string> {
    return Relay.messageUrl(await options.url)
  }

  function emitError(error: Error): void {
    if (state.closed) return
    emitter.emit('error', error)
  }

  function ensureKeypair(): Crypto.Keypair {
    state.keypair ??= Crypto.randomKeypair()
    return state.keypair
  }

  function createChannel(peerPublicKey: string): SecureChannel.Channel {
    const keypair = ensureKeypair()
    const publicKey_consumer =
      role === Relay.role.consumer ? keypair.x25519.publicKey : Relay.publicKeyToHex(peerPublicKey)
    return SecureChannel.create({
      keys: Session.derive({
        peer: { publicKey: Relay.publicKeyToHex(peerPublicKey) },
        role,
        self: keypair.x25519,
        transportContext: Relay.pairingSecretToContext(options.pairingSecret),
        transportId: 'relay',
      }),
      publicKey: publicKey_consumer,
      role,
    })
  }

  async function handleFrame(frame: Relay.Frame): Promise<void> {
    if (role === Relay.role.consumer) {
      if (frame.type === 'ready') {
        state.channel = createChannel(frame.pubkey)
        state.ready = true
        state.readyResolve?.()
        state.readyReject = undefined
        state.readyResolve = undefined
        return
      }
      if (frame.type === 'message') {
        if (!state.channel) throw new Transport.ClosedError('relay transport is not ready')
        emitter.emit('message', state.channel.open(frame.message))
        return
      }
      throw new Errors.ProtocolError('consumer received unexpected relay hello frame')
    }

    if (frame.type === 'hello') {
      if (!state.channel) {
        state.channel = createChannel(frame.pubkey)
        state.ready = true
        await postFrame({
          pubkey: Relay.publicKeyToString(ensureKeypair().x25519.publicKey),
          type: 'ready',
        })
      }
      return
    }
    if (frame.type === 'message') {
      if (!state.channel) throw new Transport.ClosedError('relay transport is not ready')
      emitter.emit('message', state.channel.open(frame.message))
      return
    }
    throw new Errors.ProtocolError('host received unexpected relay ready frame')
  }

  async function poll(): Promise<void> {
    if (state.polling) return
    state.polling = true
    while (!state.closed && state.started) {
      pollController = new AbortController()
      try {
        const response = await fetchImpl(await endpoint(), {
          headers: signHeaders({
            keypair: ensureKeypair(),
            method: 'GET',
            recipient: role,
            sessionId: options.sessionId,
            url: await endpoint(),
          }),
          method: 'GET',
          signal: pollController.signal,
        })
        if (!response.ok)
          throw new Transport.TransportError(
            `relay poll returned status ${response.status}: ${await response.text()}`,
          )
        const frames = Relay.decodeMessages(await response.text())
        for (const frame of frames) await handleFrame(frame)
      } catch (cause) {
        if (state.closed) return
        if ((cause as Error).name === 'AbortError') return
        emitError(cause as Error)
      } finally {
        pollController = undefined
      }
    }
  }

  async function postFrame(frame: Relay.Frame): Promise<void> {
    const url = await endpoint()
    const body = Relay.encodeFrame(frame)
    const response = await fetchImpl(url, {
      body,
      headers: signHeaders({
        body,
        keypair: ensureKeypair(),
        method: 'POST',
        recipient: role_peer,
        sessionId: options.sessionId,
        url,
      }),
      method: 'POST',
    })
    if (!response.ok)
      throw new Transport.TransportError(
        `relay post returned status ${response.status}: ${await response.text()}`,
      )
  }

  async function start(): Promise<void> {
    if (state.closed) throw new Transport.ClosedError('relay transport already closed')
    if (role === Relay.role.consumer && state.ready) return
    if (state.started && role === Relay.role.host) return
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        ensureKeypair()
        state.started = true
        void poll()
        if (role === Relay.role.consumer) {
          const ready = new Promise<void>((resolve, reject) => {
            state.readyReject = reject
            state.readyResolve = resolve
          })
          await postFrame({
            pubkey: Relay.publicKeyToString(ensureKeypair().x25519.publicKey),
            type: 'hello',
          })
          await ready
        }
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  return {
    async close(cause) {
      if (state.closed) return
      state.closed = true
      state.ready = false
      state.started = false
      pollController?.abort()
      state.readyReject?.(cause ?? new Transport.ClosedError('relay transport closed'))
      emitter.emit('close', cause)
    },
    exchange: 'ongoing',
    name: 'relay',
    on: emitter.on,
    role,
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('relay transport already closed')
      if (!state.started || (role === Relay.role.consumer && !state.ready)) await start()
      if (!state.channel) throw new Transport.ClosedError('relay transport is not ready')
      await postFrame({ message: state.channel.seal(envelope), type: 'message' })
    },
    start,
  }
}

export declare namespace create {
  /** Options for {@link create}. */
  type Options<role extends Relay.Role> = {
    /** Optional fetch implementation. Defaults to global fetch. */
    fetch?: typeof globalThis.fetch | undefined
    /** Shared out-of-band secret bound into the relay session keys. */
    pairingSecret: string
    /** Local role. */
    role: role
    /** Shared relay session id. */
    sessionId: string
    /** Relay endpoint URL or a promise that resolves it from discovery. */
    url: string | Promise<string>
  }
}

type State = {
  channel: SecureChannel.Channel | undefined
  closed: boolean
  keypair: Crypto.Keypair | undefined
  polling: boolean
  ready: boolean
  readyReject: ((error: Error) => void) | undefined
  readyResolve: (() => void) | undefined
  started: boolean
}

function signHeaders(options: signHeaders.Options): Record<string, string> {
  const headers: Record<string, string> = {
    [header.publicKey]: Relay.publicKeyToString(options.keypair.publicKey),
    [header.recipient]: options.recipient,
    [header.session]: options.sessionId,
  }
  const components = options.method === 'POST' ? postComponents : getComponents
  if (options.body !== undefined) {
    headers['content-digest'] = MessageSig.contentDigest(options.body)
    headers['content-type'] = 'application/json'
  }
  const signature = MessageSig.sign({
    components,
    message: { headers, method: options.method, url: options.url },
    parameters: {
      alg: 'ed25519',
      created: Math.floor(Date.now() / 1000),
      keyid: headers[header.publicKey],
      nonce: Relay.randomNonce(),
    },
    privateKey: options.keypair.privateKey,
  })
  return {
    ...headers,
    signature: signature.signature,
    'signature-input': signature.signatureInput,
  }
}

declare namespace signHeaders {
  type Options = {
    body?: string | undefined
    keypair: Crypto.Keypair
    method: 'GET' | 'POST'
    recipient: Relay.Role
    sessionId: string
    url: string
  }
}
