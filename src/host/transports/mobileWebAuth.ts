/**
 * Host-side `mobile-web-auth` transport — HTTP auth endpoint,
 * single-exchange.
 *
 * Handles `GET <path>` authorization requests, verifies the consumer's
 * callback URI against `consumer.json`, lets the host approval UI decide
 * whether to approve or deny, then redirects exactly once to the
 * callback with an encrypted `rpc-responses` envelope.
 */

import { Hono } from 'hono'
import { Base64, Hex } from 'ox'

import * as Crypto from '../../core/Crypto.js'
import * as Discovery from '../../core/Discovery.js'
import * as Envelope from '../../core/Envelope.js'
import * as Errors from '../../core/Errors.js'
import * as Events from '../../core/Events.js'
import * as Http from '../../core/Http.js'
import * as Rpc from '../../core/Rpc.js'
import * as Transport from '../../core/Transport.js'
import * as MobileWebAuthEnvelope from '../../internal/MobileWebAuthEnvelope.js'
import * as Uri from '../../internal/Uri.js'

/** Verified authorization request passed to host approval UI hooks. */
export type AuthorizationRequest = {
  /** Exact callback URI verified against the consumer's allowlist. */
  callback: string
  /** Parsed consumer discovery document. */
  consumer: Discovery.ConsumerDocument
  /** Consumer origin identifier supplied as `id`. */
  id: string
  /** Queued request envelope. */
  message: Envelope.Envelope
  /** Consumer's ephemeral X25519 public key. */
  publicKey: Hex.Hex
  /** Single-use state echoed on the callback. */
  state: string
}

/** Verified authorization request kept while the browser approval page is open. */
export type PendingRecord = AuthorizationRequest & {
  /** Lifecycle status. */
  status: 'pending'
}

/** Options accepted by {@link mobileWebAuth}. */
export type Options = {
  /**
   * Override the `fetch` implementation used for consumer discovery.
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch | undefined
  /** Bring-your-own authorization UI hooks. */
  html: html.Hooks
  /**
   * Path of the authorization endpoint. Defaults to `/`.
   */
  path?: string | undefined
}

export declare namespace html {
  /** Bring-your-own approval UI hooks. */
  type Hooks = {
    /**
     * Called for approval submissions. Inspect the request, then call
     * `actions.approve(state)` or `actions.deny(state)` and return the
     * response that should be shown to the browser.
     */
    authenticate: (options: authenticate.Options) => Response | Promise<Response>
    /**
     * Called after consumer verification. Return the approval page shown
     * in the browser. When omitted, the transport calls
     * `authenticate` immediately for simple server-side approval flows.
     */
    render?: ((options: render.Options) => Response | Promise<Response>) | undefined
    /**
     * Render a pre-verification browser error. The response must not
     * redirect to the unverified callback. When omitted, the transport
     * returns a plain text no-store error response.
     */
    renderError?: ((options: renderError.Options) => Response | Promise<Response>) | undefined
  }

  namespace authenticate {
    /** Argument passed to {@link html.Hooks.authenticate}. */
    type Options = {
      /** Approval actions for pending authorizations. */
      actions: Actions
      /** Browser request that reached the auth endpoint. */
      request: Request
    }
  }

  namespace render {
    /** Argument passed to {@link html.Hooks.render}. */
    type Options = {
      /** Approval actions for this pending authorization. */
      actions: Actions
      /** Verified pending authorization request. */
      authorization: PendingRecord
      /** Browser request that reached the auth endpoint. */
      request: Request
    }
  }

  namespace renderError {
    /** Argument passed to {@link html.Hooks.renderError}. */
    type Options = {
      /** Underlying validation error. */
      cause: Error
      /** Browser request that reached the auth endpoint. */
      request: Request
      /** HTTP status selected by the transport. */
      status: number
    }
  }

  /** Actions exposed inside {@link html.Hooks.authenticate}. */
  type Actions = {
    /** Approve a pending authorization and return the callback redirect response. */
    approve: (state?: string | undefined) => Promise<Response>
    /** Deny a pending authorization and return a callback redirect carrying JSON-RPC `-32600`. */
    deny: (state?: string | undefined, message?: string | undefined) => Promise<Response>
    /** Look up a pending authorization by state. */
    get: (state: string) => Promise<PendingRecord | undefined>
  }
}

/** Host-side mobile-web-auth transport. */
export type MobileWebAuth = Transport.Transport<'host', 'mobileWebAuth'> & Http.Server

/**
 * Create a host-side `mobile-web-auth` transport.
 */
export function mobileWebAuth(options: Options): MobileWebAuth {
  const { fetch: fetchImpl = globalThis.fetch.bind(globalThis), html, path } = options
  const authPath = path ? Uri.normalizePath(path) : '/'

  const emitter = Events.create<Transport.EventMap>()
  type Active = {
    reject: (cause: Error) => void
    resolve: (envelope: Envelope.Envelope) => void
  }
  type State = { active: Active | undefined; closed: boolean; started: boolean }
  const pending = new Map<string, PendingRecord>()
  const state: State = {
    active: undefined,
    closed: false,
    started: false,
  }

  const app = new Hono()
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
    c.res.headers.set('Pragma', 'no-cache')
  })

  app.get(authPath, async (c) => {
    let authorization: PendingRecord
    try {
      authorization = {
        ...(await parseAuthorization(c.req.raw)),
        status: 'pending',
      }
    } catch (cause) {
      return await renderError(c.req.raw, cause as Error)
    }
    pending.set(authorization.state, authorization)
    const actions = createActions(authorization.state)
    if (html.render)
      return await html.render({
        actions,
        authorization,
        request: c.req.raw,
      })
    return await html.authenticate({
      actions,
      request: c.req.raw,
    })
  })

  app.post(
    authPath,
    async (c) =>
      await html.authenticate({
        actions: createActions(),
        request: c.req.raw,
      }),
  )

  function createActions(boundState?: string | undefined): html.Actions {
    return {
      approve: (stateValue = boundState) => approve(pendingRecord(stateValue)),
      async deny(stateValue = boundState, message = 'User denied the request.') {
        const authorization = pendingRecord(stateValue)
        return await redirectWithResponse(
          authorization,
          Envelope.rpcResponses([
            Rpc.error({ code: -32600, id: firstRequestId(authorization.message), message }),
          ]),
        )
      },
      async get(stateValue) {
        return pending.get(stateValue)
      },
    }
  }

  function pendingRecord(stateValue: string | undefined): PendingRecord {
    if (!stateValue) throw new UnknownStateError('')
    const authorization = pending.get(stateValue)
    if (!authorization) throw new UnknownStateError(stateValue)
    return authorization
  }

  async function parseAuthorization(request: Request): Promise<AuthorizationRequest> {
    const url = new URL(request.url)
    if (Uri.requiredSearchParam(url, 'version') !== '1')
      throw new PreVerificationError('unsupported mobile-web-auth version', { status: 400 })
    const id = assertConsumerId(requiredParam(url, 'id'))
    const callback = assertCallback(requiredParam(url, 'callback'))
    const stateValue = requiredParam(url, 'state')
    if (!isBase64Url(stateValue) || Base64.toBytes(stateValue).length < 16)
      throw new PreVerificationError('state must contain at least 128 bits', { status: 400 })
    const publicKey = parsePublicKey(requiredParam(url, 'pubkey'))
    const consumer = await fetchConsumer(id)
    if (!consumer.callback_urls?.includes(callback))
      throw new PreVerificationError('callback is not registered by consumer', { status: 403 })
    const message = parseMessage(requiredParam(url, 'message'))
    if (message.type !== 'rpc-requests')
      throw new PreVerificationError('message must be an rpc-requests envelope', { status: 400 })
    return {
      callback,
      consumer,
      id,
      message,
      publicKey,
      state: stateValue,
    }
  }

  async function fetchConsumer(id: string): Promise<Discovery.ConsumerDocument> {
    try {
      return await Discovery.fetchConsumer(id, { fetch: fetchImpl })
    } catch (cause) {
      throw new PreVerificationError('consumer discovery failed', {
        cause: cause as Error,
        status: 403,
      })
    }
  }

  async function approve(authorization: PendingRecord): Promise<Response> {
    if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
    if (state.active)
      throw new Transport.TransportError(
        'mobile-web-auth is single-exchange; a previous approval is still in flight',
      )
    pending.delete(authorization.state)
    const response = new Promise<Envelope.Envelope>((resolve, reject) => {
      state.active = { reject, resolve }
    })
    emitter.emit('message', authorization.message)
    try {
      return await redirectWithResponse(authorization, await response)
    } finally {
      state.active = undefined
    }
  }

  async function redirectWithResponse(
    authorization: AuthorizationRequest,
    response: Envelope.Envelope,
  ): Promise<Response> {
    pending.delete(authorization.state)
    const keypair = Crypto.randomKeypair()
    const message = MobileWebAuthEnvelope.sealResponse({
      publicKey: authorization.publicKey,
      response,
      self: keypair.x25519,
    })
    const url = new URL(authorization.callback)
    url.searchParams.set('message', MobileWebAuthEnvelope.encodeJson(message))
    url.searchParams.set('pubkey', Crypto.encodePublicKey(keypair.x25519.publicKey))
    url.searchParams.set('state', authorization.state)
    url.searchParams.set('version', '1')
    state.closed = true
    emitter.emit('close', undefined)
    return new Response(null, { headers: { location: url.toString() }, status: 302 })
  }

  async function renderError(request: Request, cause: Error): Promise<Response> {
    const status = cause instanceof PreVerificationError ? cause.status : 500
    if (html.renderError) {
      const response = await html.renderError({ cause, request, status })
      if (response.status < 300 || response.status >= 400) return response
    }
    return new Response(cause.message, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      status,
    })
  }

  const { fetch, listener } = Http.fromHono(app)

  return {
    capabilities: {
      notifications: { consumer: false, host: false },
      requests: { consumer: true, host: false },
    },
    async close(cause) {
      if (state.closed) return
      state.closed = true
      state.active?.reject(cause ?? new Transport.ClosedError('mobile-web-auth transport closed'))
      state.active = undefined
      pending.clear()
      emitter.emit('close', cause)
    },
    discovery: {
      binding(baseUrl) {
        return {
          auth_url: `${Uri.trimTrailingSlash(baseUrl)}${authPath === '/' ? '' : authPath}`,
        }
      },
      id: 'mobile-web-auth',
    },
    exchange: 'single_exchange',
    fetch,
    listener,
    name: 'mobileWebAuth',
    on: emitter.on,
    role: 'host',
    routes: [authPath],
    async send(envelope) {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      if (!state.started) throw new Transport.ClosedError('mobile-web-auth transport not started')
      const active = state.active
      if (!active)
        throw new Transport.TransportError(
          'no active mobile-web-auth approval; `transport.send` was called before approval',
        )
      active.resolve(envelope)
    },
    async start() {
      if (state.closed) throw new Transport.ClosedError('mobile-web-auth transport already closed')
      state.started = true
    },
  }
}

function assertCallback(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new PreVerificationError('callback is not a valid URI', {
      cause: cause as Error,
      status: 400,
    })
  }
  if (url.hash)
    throw new PreVerificationError('callback must not contain a fragment', { status: 400 })
  if (!Uri.isAllowedAppCallback(url))
    throw new PreVerificationError(
      'callback must be HTTPS, loopback HTTP, or reverse-DNS private-use URI',
      { status: 400 },
    )
  return url.toString()
}

function assertConsumerId(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new PreVerificationError('id is not a valid URL', { cause: cause as Error, status: 400 })
  }
  if (url.protocol !== 'https:' && !Uri.isLoopbackHttp(url))
    throw new PreVerificationError('id must be an HTTPS origin', { status: 400 })
  if (url.pathname !== '/' || url.search || url.hash)
    throw new PreVerificationError('id must not include path, query, or fragment', { status: 400 })
  return url.origin
}

function firstRequestId(envelope: Envelope.Envelope): Rpc.Id | null {
  if (envelope.type !== 'rpc-requests') return null
  for (const message of envelope.payload) if ('id' in message) return message.id
  return null
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]*={0,2}$/.test(value)
}

function parseMessage(value: string): Envelope.Envelope {
  try {
    return Envelope.parse(MobileWebAuthEnvelope.decodeJson(value))
  } catch (cause) {
    throw new PreVerificationError('message is not a valid envelope', {
      cause: cause as Error,
      status: 400,
    })
  }
}

function parsePublicKey(value: string): Hex.Hex {
  try {
    return Crypto.decodePublicKey(value)
  } catch (cause) {
    throw new PreVerificationError('pubkey is not a valid X25519 public key', {
      cause: cause as Error,
      status: 400,
    })
  }
}

function requiredParam(url: URL, key: string): string {
  const value = Uri.requiredSearchParam(url, key)
  if (!value)
    throw new PreVerificationError(`missing required \`${key}\` parameter`, { status: 400 })
  return value
}

class PreVerificationError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'MobileWebAuth.PreVerificationError'
  status: number

  constructor(
    message: string,
    options: Errors.BaseError.Options<cause> & { status: number } = { status: 400 } as never,
  ) {
    super(message, options)
    this.status = options.status
  }
}

class UnknownStateError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'MobileWebAuth.UnknownStateError'

  constructor(state: string, options: Errors.BaseError.Options<cause> = {} as never) {
    super(`no pending mobile-web-auth session for state \`${state}\``, options)
  }
}
