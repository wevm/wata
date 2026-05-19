/**
 * Minimal in-memory relay server for the `relay` transport.
 */

import { Hono } from 'hono'

import * as Errors from '../core/Errors.js'
import * as Http from '../core/Http.js'
import * as Relay from '../core/internal/relay.js'
import * as MessageSig from '../core/MessageSig.js'

const header = {
  publicKey: 'urpc-public-key',
  recipient: 'urpc-recipient',
  session: 'urpc-session',
} as const

const corsHeaders = {
  'access-control-allow-headers':
    'content-digest, content-type, signature, signature-input, urpc-public-key, urpc-recipient, urpc-session',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-origin': '*',
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

/** Create an in-memory relay server. */
export function relayServer(options: relayServer.Options = {}): Http.Server {
  const responseTimeout = Math.max(0, options.responseTimeout ?? 10_000)
  const sessions = new Map<string, Session>()
  const app = new Hono()

  app.options('/*', () => new Response(null, { headers: corsHeaders, status: 204 }))

  app.get('/*', async (c) => {
    try {
      const request = c.req.raw
      if (!isMessagesPath(request)) return notFound()
      verify(request, getComponents)
      const { recipient, sessionId } = routing(request)
      const messages = take(session(sessionId), recipient)
      if (messages.length > 0) return json({ messages })
      return await wait(session(sessionId), recipient, responseTimeout)
    } catch (cause) {
      return errorResponse(cause as Error)
    }
  })

  app.post('/*', async (c) => {
    try {
      const request = c.req.raw
      if (!isMessagesPath(request)) return notFound()
      const body = await request.text()
      verify(request, postComponents, body)
      const { recipient, sessionId } = routing(request)
      const frame = Relay.decodeFrame(body)
      enqueue(session(sessionId), recipient, frame)
      return new Response(null, { headers: corsHeaders, status: 202 })
    } catch (cause) {
      return errorResponse(cause as Error)
    }
  })

  function session(id: string): Session {
    let value = sessions.get(id)
    if (!value) {
      value = {
        queues: {
          consumer: [],
          host: [],
        },
        waiters: {
          consumer: [],
          host: [],
        },
      }
      sessions.set(id, value)
    }
    return value
  }

  return Http.fromHono(app)
}

export declare namespace relayServer {
  /** Options for {@link relayServer}. */
  type Options = {
    /** Long-poll timeout in milliseconds. Defaults to 10 seconds. */
    responseTimeout?: number | undefined
  }
}

type Session = {
  queues: Record<Relay.Role, Relay.Frame[]>
  waiters: Record<Relay.Role, Waiter[]>
}

type Waiter = {
  resolve: (messages: readonly Relay.Frame[]) => void
  timeout: ReturnType<typeof setTimeout>
}

function enqueue(session: Session, recipient: Relay.Role, frame: Relay.Frame): void {
  session.queues[recipient].push(frame)
  const waiter = session.waiters[recipient].shift()
  if (!waiter) return
  clearTimeout(waiter.timeout)
  waiter.resolve(take(session, recipient))
}

function errorResponse(error: Error): Response {
  const status = error instanceof MessageSig.InvalidSignatureError ? 401 : 400
  return new Response(error.message, { headers: corsHeaders, status })
}

function headers(request: Request): Record<string, string> {
  const out: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function isMessagesPath(request: Request): boolean {
  return new URL(request.url).pathname.endsWith('/messages')
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  })
}

function notFound(): Response {
  return new Response(null, { headers: corsHeaders, status: 404 })
}

function routing(request: Request): { recipient: Relay.Role; sessionId: string } {
  const sessionId = request.headers.get(header.session)
  const recipient = request.headers.get(header.recipient)
  if (!sessionId) throw new Errors.ProtocolError('relay request is missing `urpc-session`')
  if (recipient !== Relay.role.consumer && recipient !== Relay.role.host)
    throw new Errors.ProtocolError('relay request has invalid `urpc-recipient`')
  return { recipient, sessionId }
}

function take(session: Session, recipient: Relay.Role): readonly Relay.Frame[] {
  return session.queues[recipient].splice(0)
}

function verify(request: Request, components: readonly string[], body?: string | undefined): void {
  const publicKey = request.headers.get(header.publicKey)
  if (!publicKey) throw new MessageSig.InvalidSignatureError('missing `urpc-public-key` header')
  if (body !== undefined) {
    const digest = request.headers.get('content-digest')
    if (digest !== MessageSig.contentDigest(body))
      throw new MessageSig.InvalidSignatureError('content-digest mismatch')
  }
  const ok = MessageSig.verify({
    message: {
      headers: headers(request),
      method: request.method,
      url: request.url,
    },
    publicKey: Relay.publicKeyToHex(publicKey),
    requiredComponents: components,
  })
  if (!ok) throw new MessageSig.InvalidSignatureError('relay request signature did not verify')
}

function wait(session: Session, recipient: Relay.Role, responseTimeout: number): Promise<Response> {
  return new Promise((resolve) => {
    const waiter: Waiter = {
      resolve: (messages) => resolve(json({ messages })),
      timeout: setTimeout(() => {
        const index = session.waiters[recipient].indexOf(waiter)
        if (index >= 0) session.waiters[recipient].splice(index, 1)
        resolve(json({ messages: [] }))
      }, responseTimeout),
    }
    session.waiters[recipient].push(waiter)
  })
}
