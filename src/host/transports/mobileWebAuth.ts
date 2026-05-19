/**
 * Host-side `mobile-web-auth` transport.
 *
 * Exposes a single Hono-backed authorization endpoint. The host verifies
 * the consumer's published callback allowlist, renders the approval UI,
 * dispatches the queued `rpc-requests` envelope into `Wata`, then
 * redirects back to the app callback with an encrypted response frame.
 */

import { Hono } from 'hono'
import type { Hex } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Http from '../../core/Http.js'
import * as core_mobileWebAuth from '../../core/internal/mobileWebAuth.js'
import * as Session from '../../core/Session.js'
import * as Transport from '../../core/Transport.js'

/** Pending authorization request held between GET and approval POST. */
export type PendingRecord = {
  /** Exact callback URL verified against the consumer's discovery document. */
  callbackUrl: string
  /** Epoch-ms creation. */
  createdAt: number
  /** Consumer id/origin from the authorization request. */
  id: string
  /** Pending JSON-RPC request envelope, when supplied. */
  message: Envelope.Envelope | undefined
  /** Consumer ephemeral X25519 public key. */
  publicKey: Hex.Hex
  /** Opaque state echoed to the callback URL. */
  state: string
  /** Lifecycle status. */
  status: 'pending' | 'approved' | 'denied'
}

/** Options accepted by {@link mobileWebAuth}. */
export type Options = {
  /** Override the consumer-discovery `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch | undefined
  /** Bring-your-own approval UI hooks. */
  html: html.Hooks
  /** Authorization endpoint path. Defaults to `/auth/mobile`. */
  path?: string | undefined
}

export declare namespace html {
  /** Bring-your-own approval UI hooks. */
  type Hooks = {
    /** Called for approval POSTs. */
    authenticate: (options: authenticate.Options) => Response | Promise<Response>
    /** Called for authorization GETs. */
    render: (options: render.Options) => Response | Promise<Response>
  }

  namespace authenticate {
    /** Argument passed to {@link html.Hooks.authenticate}. */
    type Options = {
      /** Approval actions exposed to the host's auth page. */
      actions: Actions
      /** Original form POST request. */
      request: Request
    }
  }

  namespace render {
    /** Argument passed to {@link html.Hooks.render}. */
    type Options = {
      /** Verified pending record, when the authorization request was valid. */
      record: PendingRecord | undefined
      /** Original authorization request. */
      request: Request
    }
  }

  /** Actions exposed inside {@link html.Hooks.authenticate}. */
  type Actions = {
    /** Approve the pending session and return the callback redirect URL. */
    approve: (state: string) => Promise<string>
    /** Deny the pending session and return the callback redirect URL. */
    deny: (state: string) => Promise<string>
    /** Look up a pending session by state. */
    get: (state: string) => Promise<PendingRecord | undefined>
  }
}

/** `mobile-web-auth` host transport plus `.fetch` / `.listener`. */
export type MobileWebAuth = Transport.Transport<'host', 'mobileWebAuth'> & Http.Server

/**
 * Create a host-side `mobile-web-auth` transport.
 *
 * @example
 * ```ts
 * import { Wata, mobileWebAuth } from 'wata/host'
 *
 * const wata = Wata.create({
 *   transports: [
 *     mobileWebAuth({
 *       html: {
 *         authenticate: async ({ actions, request }) => {
 *           const form = await request.formData()
 *           return Response.redirect(await actions.approve(String(form.get('state'))))
 *         },
 *         render: ({ record }) => new Response(record?.state),
 *       },
 *     }),
 *   ],
 * })
 * ```
 */
export function mobileWebAuth(options: Options): MobileWebAuth {
  const {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    html,
    path = '/auth/mobile',
  } = options

  const records = new Map<string, PendingRecord>()
  const responders = new Map<string, Responder>()
  const emitter = Events.create<Transport.EventMap>()

  type State = {
    activeState: string | undefined
    closed: boolean
    started: boolean
  }
  const state: State = {
    activeState: undefined,
    closed: false,
    started: false,
  }

  const actions: html.Actions = {
    async approve(sessionState) {
      const record = records.get(sessionState)
      if (!record) throw new UnknownStateError(sessionState)
      if (record.status !== 'pending')
        throw new Transport.ClosedError('mobile-web-auth session is already settled')
      if (!record.message) throw new Errors.ProtocolError('mobile-web-auth request has no message')
      record.status = 'approved'
      records.set(sessionState, record)
      const redirect = new Promise<string>((resolve, reject) => {
        responders.set(sessionState, { reject, resolve })
      })
      state.activeState = sessionState
      emitter.emit('message', record.message)
      return await redirect
    },
    async deny(sessionState) {
      const record = records.get(sessionState)
      if (!record) throw new UnknownStateError(sessionState)
      record.status = 'denied'
      records.set(sessionState, record)
      return buildRedirectUrl({
        envelope: Envelope.rpcResponses([]),
        record,
      })
    },
    async get(sessionState) {
      return records.get(sessionState)
    },
  }

  const app = new Hono().basePath(path)

  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
    c.res.headers.set('Pragma', 'no-cache')
  })

  app.onError((cause, c) => {
    emitter.emit('error', cause as Error)
    return c.text((cause as Error).message, { status: 500 })
  })

  app.get('/', async (c) => {
    const result = parseAuthorizationRequest(new URL(c.req.url))
    if ('response' in result) return result.response

    const verification = await verifyConsumer(result.record.id, result.record.callbackUrl)
    if (!verification)
      return new Response('consumer verification failed', {
        headers: noStoreHeaders(),
        status: 403,
      })

    records.set(result.record.state, result.record)
    return await html.render({ record: result.record, request: c.req.raw })
  })

  app.post('/', async (c) => await html.authenticate({ actions, request: c.req.raw }))

  const { fetch, listener } = Http.fromHono(app)

  async function verifyConsumer(id: string, callbackUrl: string): Promise<boolean> {
    try {
      const document = await Discovery.fetchConsumer(id, { fetch: fetchImpl })
      return document.callback_urls?.includes(callbackUrl) ?? false
    } catch (cause) {
      emitter.emit('error', cause as Error)
      return false
    }
  }

  function buildRedirectUrl(options: buildRedirectUrl.Options): string {
    const { envelope, record } = options
    const keypair = Crypto.randomKeypair()
    const keys = Session.derive({
      peer: { publicKey: record.publicKey },
      role: 'host',
      self: keypair.x25519,
      transportId: core_mobileWebAuth.transportId,
    })
    const url = new URL(record.callbackUrl)
    url.searchParams.set(
      'message',
      core_mobileWebAuth.encodeMessage(
        core_mobileWebAuth.seal({
          envelope,
          from: Envelope.from.host,
          key: keys.h2c,
          publicKey: record.publicKey,
        }),
      ),
    )
    url.searchParams.set('pubkey', core_mobileWebAuth.encodePublicKey(keypair.x25519.publicKey))
    url.searchParams.set('state', record.state)
    url.searchParams.set('version', '1')
    return url.toString()
  }

  return {
    async close(cause) {
      if (state.closed) return
      state.closed = true
      for (const responder of responders.values())
        responder.reject(cause ?? new Transport.ClosedError('mobile-web-auth transport closed'))
      responders.clear()
      records.clear()
      state.activeState = undefined
      emitter.emit('close', cause)
    },
    discovery: {
      binding(baseUrl) {
        return { auth_url: `${baseUrl.replace(/\/+$/, '')}${path}` }
      },
      id: core_mobileWebAuth.transportId,
    },
    exchange: 'single_exchange',
    fetch,
    listener,
    name: 'mobileWebAuth',
    on: emitter.on,
    role: 'host',
    routes: [path],
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      if (!state.started) throw new Transport.ClosedError('mobile-web-auth transport not started')
      const sessionState = state.activeState
      if (!sessionState)
        throw new Transport.TransportError(
          'no active mobile-web-auth approval; `transport.send` was called before approval',
        )
      const record = records.get(sessionState)
      const responder = responders.get(sessionState)
      if (!record || !responder)
        throw new Transport.ClosedError(
          'pending mobile-web-auth session disappeared before response delivery',
        )
      responders.delete(sessionState)
      records.delete(sessionState)
      state.activeState = undefined
      state.closed = true
      responder.resolve(buildRedirectUrl({ envelope, record }))
      emitter.emit('close', undefined)
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      state.started = true
    },
  }
}

type AuthorizationParseResult = { record: PendingRecord } | { response: Response }

type Responder = {
  reject: (error: Error) => void
  resolve: (url: string) => void
}

function parseAuthorizationRequest(url: URL): AuthorizationParseResult {
  const callbackUrl = url.searchParams.get('callback')
  const id = url.searchParams.get('id')
  const publicKey = url.searchParams.get('pubkey')
  const sessionState = url.searchParams.get('state')
  const version = url.searchParams.get('version')

  if (version !== '1') return badRequest('expected `version=1`')
  if (!callbackUrl) return badRequest('missing `callback`')
  if (!id) return badRequest('missing `id`')
  if (!publicKey) return badRequest('missing `pubkey`')
  if (!sessionState) return badRequest('missing `state`')

  const callback = Discovery.schema.callbackUrl.safeParse(callbackUrl)
  if (!callback.success) return badRequest('invalid `callback`')

  const idUrl = parseUrl(id)
  if (!idUrl) return badRequest('invalid `id`')
  if (idUrl.origin !== id || idUrl.pathname !== '/' || idUrl.search || idUrl.hash)
    return badRequest('`id` must be an origin URL')

  const message = url.searchParams.get('message')
  const envelope = message ? parseMessage(message) : undefined
  if (envelope instanceof Response) return { response: envelope }
  if (envelope && envelope.type !== 'rpc-requests')
    return badRequest('`message` must be an `rpc-requests` envelope')

  const publicKey_hex = parsePublicKey(publicKey)
  if (publicKey_hex instanceof Response) return { response: publicKey_hex }

  return {
    record: {
      callbackUrl,
      createdAt: Date.now(),
      id,
      message: envelope,
      publicKey: publicKey_hex,
      state: sessionState,
      status: 'pending',
    },
  }
}

declare namespace buildRedirectUrl {
  /** Options for `buildRedirectUrl`. */
  type Options = {
    /** Plaintext envelope to encrypt into the callback frame. */
    envelope: Envelope.Envelope
    /** Pending session record. */
    record: PendingRecord
  }
}

function badRequest(message: string): AuthorizationParseResult {
  return {
    response: new Response(message, {
      headers: noStoreHeaders(),
      status: 400,
    }),
  }
}

function parseMessage(message: string): Envelope.Envelope | Response {
  try {
    return core_mobileWebAuth.decodeMessage(message)
  } catch (cause) {
    return new Response((cause as Error).message, {
      headers: noStoreHeaders(),
      status: 400,
    })
  }
}

function parsePublicKey(publicKey: string): Hex.Hex | Response {
  try {
    return core_mobileWebAuth.decodePublicKey(publicKey)
  } catch (cause) {
    return new Response((cause as Error).message, {
      headers: noStoreHeaders(),
      status: 400,
    })
  }
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

function noStoreHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  })
}

/** Thrown when a supplied state does not match a pending session. */
export class UnknownStateError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'MobileWebAuth.UnknownStateError'

  constructor(state: string, options: Errors.BaseError.Options<cause> = {} as never) {
    super(`no pending mobile-web-auth session for state \`${state}\``, options)
  }
}
