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
import { z } from 'zod/mini'

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

/** Parsed mobile-web-auth authorization request. */
export type Authorization = {
  /** Callback URI supplied by the consumer. */
  callback: string
  /** Consumer origin identifier supplied as `id`. */
  id: string
  /** Queued request envelope. */
  message: Envelope.Envelope
  /** Consumer's ephemeral X25519 public key. */
  publicKey: Hex.Hex
  /** Single-use state echoed on the callback. */
  state: string
}

/** Verified authorization request passed to host approval UI hooks. */
export type AuthorizationRequest = Authorization & {
  /** Parsed consumer discovery document. */
  consumer: Discovery.ConsumerDocument
}

/** Verified authorization request kept while the browser approval page is open. */
export type PendingRecord = AuthorizationRequest & {
  /** Lifecycle status. */
  status: 'pending'
}

/** Zod schemas for mobile-web-auth host helper inputs. */
export namespace schema {
  /** 32-byte `0x`-prefixed hex X25519 public key. */
  export const publicKey = z.templateLiteral(['0x', z.string().check(z.regex(/^[0-9a-fA-F]{64}$/))])

  /** Single-use state with at least 128 bits of entropy. */
  export const state = z.string().check(
    z.regex(/^[A-Za-z0-9_-]*={0,2}$/),
    z.refine((value) => Base64.toBytes(value).length >= 16, {
      error: 'expected at least 128 bits of base64url entropy',
    }),
  )

  /** Serialized mobile-web-auth authorization persisted by host applications. */
  export const serializedAuthorization = z.object({
    callback: z.string(),
    id: z.string(),
    message: Envelope.schema.rpcRequests,
    publicKey,
    state,
  })
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

/** Builds an encrypted mobile-web-auth callback URL carrying an error response. */
export function errorUrl(options: errorUrl.Options): errorUrl.ReturnType {
  const { authorization, error } = options
  const id = options.id === undefined ? firstRequestId(authorization.message) : options.id
  return responseUrl({
    authorization,
    response: Envelope.rpcResponses([
      Rpc.error({
        code: error.code,
        id,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      }),
    ]),
  })
}

export declare namespace errorUrl {
  /** Options for {@link errorUrl}. */
  type Options = {
    /** Authorization being answered. */
    authorization: Authorization
    /** JSON-RPC error payload to return through the callback. */
    error: {
      /** JSON-RPC error code. */
      code: number
      /** Optional JSON-RPC error data. */
      data?: unknown | undefined
      /** JSON-RPC error message. */
      message: string
    }
    /** JSON-RPC request id to answer. Defaults to the first request id in the authorization. */
    id?: Rpc.Id | null | undefined
  }
  /** Return type for {@link errorUrl}. */
  type ReturnType = string
}

/** Parses a mobile-web-auth authorization URL or browser request. */
export function parseAuthorization(input: parseAuthorization.Input): parseAuthorization.ReturnType {
  const url = urlFromInput(input)
  if (requiredParam(url, 'version') !== '1')
    throw new PreVerificationError('unsupported mobile-web-auth version', { status: 400 })
  const callback = assertCallback(requiredParam(url, 'callback'))
  const id = assertConsumerId(requiredParam(url, 'id'))
  const message = parseMessage(requiredParam(url, 'message'))
  if (message.type !== 'rpc-requests')
    throw new PreVerificationError('message must be an rpc-requests envelope', { status: 400 })
  const publicKey = parsePublicKey(requiredParam(url, 'pubkey'))
  const stateValue = requiredParam(url, 'state')
  if (!isBase64Url(stateValue) || Base64.toBytes(stateValue).length < 16)
    throw new PreVerificationError('state must contain at least 128 bits', { status: 400 })
  return {
    callback,
    id,
    message,
    publicKey,
    state: stateValue,
  }
}

export declare namespace parseAuthorization {
  /** Input accepted by {@link parseAuthorization}. */
  type Input = Request | string | URL
  /** Return type for {@link parseAuthorization}. */
  type ReturnType = Authorization
}

/** Parses mobile-web-auth authorization search parameters with string values. */
export function parseAuthorizationSearch(
  search: parseAuthorizationSearch.Input,
): parseAuthorizationSearch.ReturnType {
  const url = new URL('https://mobile-web-auth.local/')
  for (const [key, value] of searchEntries(search)) url.searchParams.set(key, value)
  return parseAuthorization(url)
}

export declare namespace parseAuthorizationSearch {
  /** Input accepted by {@link parseAuthorizationSearch}. */
  type Input = Record<string, unknown> | URLSearchParams
  /** Return type for {@link parseAuthorizationSearch}. */
  type ReturnType = Authorization
}

/** Restores a serialized mobile-web-auth authorization record. */
export function parseSerializedAuthorization(
  value: string,
): parseSerializedAuthorization.ReturnType {
  const json = (() => {
    try {
      return JSON.parse(value)
    } catch (cause) {
      throw new PreVerificationError('authorization must be valid JSON', {
        cause: cause as Error,
        status: 400,
      })
    }
  })()
  const result = schema.serializedAuthorization.safeParse(json)
  if (!result.success)
    throw new PreVerificationError('authorization must be a serialized mobile-web-auth request', {
      details: result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
      status: 400,
    })
  const parsed = result.data
  const authorization = {
    callback: assertCallback(parsed.callback),
    id: assertConsumerId(parsed.id),
    message: parsed.message,
    publicKey: parsed.publicKey,
    state: parsed.state,
  }
  return authorization
}

export declare namespace parseSerializedAuthorization {
  /** Return type for {@link parseSerializedAuthorization}. */
  type ReturnType = Authorization
}

/** Builds an encrypted mobile-web-auth callback URL carrying a response envelope. */
export function responseUrl(options: responseUrl.Options): responseUrl.ReturnType {
  const { authorization, response } = options
  if (response.type !== 'rpc-responses')
    throw new Errors.ProtocolError('mobile-web-auth callback response must be rpc-responses')
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
  return url.toString()
}

export declare namespace responseUrl {
  /** Options for {@link responseUrl}. */
  type Options = {
    /** Authorization being answered. */
    authorization: Authorization
    /** JSON-RPC response envelope to return through the callback. */
    response: Envelope.Envelope
  }
  /** Return type for {@link responseUrl}. */
  type ReturnType = string
}

/** Returns the first JSON-RPC request carried by an authorization. */
export function request(authorization: Authorization): request.ReturnType {
  if (authorization.message.type !== 'rpc-requests') throw new RequestNotFoundError()
  for (const message of authorization.message.payload) if ('id' in message) return message
  throw new RequestNotFoundError()
}

export declare namespace request {
  /** Return type for {@link request}. */
  type ReturnType = Rpc.Request
}

/** Serializes a mobile-web-auth authorization for app-managed persistence. */
export function serializeAuthorization(
  authorization: Authorization,
): serializeAuthorization.ReturnType {
  return JSON.stringify({
    callback: authorization.callback,
    id: authorization.id,
    message: authorization.message,
    publicKey: authorization.publicKey,
    state: authorization.state,
  })
}

export declare namespace serializeAuthorization {
  /** Return type for {@link serializeAuthorization}. */
  type ReturnType = string
}

/** Builds an encrypted mobile-web-auth callback URL carrying a success response. */
export function successUrl(options: successUrl.Options): successUrl.ReturnType {
  const { authorization, result } = options
  const id = options.id === undefined ? firstRequestId(authorization.message) : options.id
  return responseUrl({
    authorization,
    response: Envelope.rpcResponses([
      Rpc.success({
        id,
        result,
      }),
    ]),
  })
}

export declare namespace successUrl {
  /** Options for {@link successUrl}. */
  type Options = {
    /** Authorization being answered. */
    authorization: Authorization
    /** JSON-RPC request id to answer. Defaults to the first request id in the authorization. */
    id?: Rpc.Id | null | undefined
    /** JSON-RPC result payload to return through the callback. */
    result: unknown
  }
  /** Return type for {@link successUrl}. */
  type ReturnType = string
}

/** Verifies that a parsed authorization's callback is registered by its consumer. */
export async function verifyAuthorization(
  authorization: Authorization,
  options: verifyAuthorization.Options = {},
): verifyAuthorization.ReturnType {
  const { fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = options
  let consumer: Discovery.ConsumerDocument
  try {
    consumer = await Discovery.fetchConsumer(authorization.id, { fetch: fetchImpl })
  } catch (cause) {
    throw new PreVerificationError('consumer discovery failed', {
      cause: cause as Error,
      status: 403,
    })
  }
  if (!consumer.callback_urls?.includes(authorization.callback))
    throw new PreVerificationError('callback is not registered by consumer', { status: 403 })
  return {
    callback: authorization.callback,
    consumer,
    id: authorization.id,
    message: authorization.message,
    publicKey: authorization.publicKey,
    state: authorization.state,
  }
}

export declare namespace verifyAuthorization {
  /** Options for {@link verifyAuthorization}. */
  type Options = {
    /**
     * Override the `fetch` implementation used for consumer discovery.
     * Defaults to `globalThis.fetch`.
     */
    fetch?: typeof globalThis.fetch | undefined
  }
  /** Return type for {@link verifyAuthorization}. */
  type ReturnType = Promise<AuthorizationRequest>
}

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
        ...(await parseAuthorizationRequest(c.req.raw)),
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

  async function parseAuthorizationRequest(request: Request): Promise<AuthorizationRequest> {
    return await verifyAuthorization(parseAuthorization(request), { fetch: fetchImpl })
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
    const url = responseUrl({ authorization, response })
    state.closed = true
    emitter.emit('close', undefined)
    return new Response(null, { headers: { location: url }, status: 302 })
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

  const { fetch } = Http.fromHono(app)

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

function searchEntries(search: parseAuthorizationSearch.Input): [string, string][] {
  if (search instanceof URLSearchParams) return [...search.entries()]
  return Object.entries(search).map(([key, value]) => {
    if (key === 'version' && typeof value === 'number' && Number.isFinite(value))
      return [key, String(value)]
    if (typeof value !== 'string')
      throw new PreVerificationError(`search parameter \`${key}\` must be a string`, {
        status: 400,
      })
    return [key, value]
  })
}

function urlFromInput(input: parseAuthorization.Input): URL {
  try {
    if (input instanceof URL) return input
    if (input instanceof Request) return new URL(input.url)
    return new URL(input)
  } catch (cause) {
    throw new PreVerificationError('authorization URL is not a valid URL', {
      cause: cause as Error,
      status: 400,
    })
  }
}

/** Thrown when a mobile-web-auth browser request fails before callback verification. */
export class PreVerificationError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'MobileWebAuth.PreVerificationError'
  /** HTTP status selected for browser error rendering. */
  status: number

  constructor(
    message: string,
    options: Errors.BaseError.Options<cause> & { status: number } = { status: 400 } as never,
  ) {
    super(message, options)
    this.status = options.status
  }
}

/** Thrown when an authorization does not carry a JSON-RPC request. */
export class RequestNotFoundError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'MobileWebAuth.RequestNotFoundError'

  constructor(options: Errors.BaseError.Options<cause> = {} as never) {
    super('mobile-web-auth authorization does not contain a JSON-RPC request', options)
  }
}

/** Thrown when approval actions reference a missing mobile-web-auth state. */
export class UnknownStateError<
  cause extends Error | undefined = Error | undefined,
> extends Errors.BaseError<cause> {
  override name = 'MobileWebAuth.UnknownStateError'

  constructor(state: string, options: Errors.BaseError.Options<cause> = {} as never) {
    super(`no pending mobile-web-auth session for state \`${state}\``, options)
  }
}
