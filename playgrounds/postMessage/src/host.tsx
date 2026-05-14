/**
 * Host-side React app for the postMessage playground.
 *
 * Minimal UI: status pill + a single "respond" button per pending
 * request + a compact log. Hardcoded result for `ping`; everything
 * else gets `{}`. The `request` listener stashes the raw event id and
 * `handshake.respond(id, result)` answers it later. No explicit
 * `start()` — `handshake.on(...)` lazy-starts the transport.
 */

import { Handshake, postMessage } from 'handshakes/host'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Input, Tag } from 'regen-ui'

import * as Log from './Log.js'

import './styles.css'

/**
 * Mirrors {@link Log.useLog} but, for every push, also broadcasts the
 * entry on a same-origin `BroadcastChannel` so the consumer page can
 * render a host-side log panel under the host window chrome. We use a
 * `BroadcastChannel` (not `window.postMessage`) so the relay traffic
 * doesn't reach the handshake transport's envelope parser.
 */
function useRelayLog(): Log.Log {
  const base = Log.useLog()
  return useMemo<Log.Log>(
    () => ({
      entries: base.entries,
      clear: base.clear,
      push: (entry) => {
        base.push(entry)
        try {
          const channel = new BroadcastChannel('handshakes-host-log')
          channel.postMessage(entry)
          channel.close()
        } catch {}
      },
    }),
    [base],
  )
}

const stateIntent = {
  idle: 'neutral',
  open: 'positive',
  closed: 'neutral',
  error: 'negative',
} as const

type State = keyof typeof stateIntent

type Pending = { id: number | string; method: string; params: unknown }

function App() {
  const [state, setState] = useState<State>('idle')
  const [pending, setPending] = useState<readonly Pending[]>([])
  const [pongs, setPongs] = useState<Record<string, string>>({})
  const log = useRelayLog()
  const handshakeRef = useRef<Handshake.Host | undefined>(undefined)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const peer = detectPeer()
    if (!peer) {
      log.push({ intent: 'warning', label: 'no opener / parent' })
      return
    }

    const handshake = Handshake.create({
      transport: postMessage<Window>({
        targetOrigin: peer.origin ?? '*',
        open: () => peer.window,
        close: () => {},
      }),
    })
    handshakeRef.current = handshake

    handshake.on('open', () => {
      setState('open')
      log.push({ intent: 'positive', label: 'open' })
    })
    handshake.on('close', (cause) => {
      setState('closed')
      log.push({ intent: 'neutral', label: 'close', detail: cause })
    })
    handshake.on('error', (error) => {
      setState('error')
      log.push({ intent: 'negative', label: 'error', detail: error })
    })
    handshake.on('notification', (event) => {
      log.push({ intent: 'accent', label: 'notification', detail: event.params })
    })
    handshake.on('request', (event) => {
      log.push({
        intent: 'accent',
        label: 'request',
        requestId: event.id,
        detail: event.params,
      })
      setPending((prev) => [...prev, { id: event.id, method: event.method, params: event.params }])
    })
  }, [log])

  const respond = useCallback(
    (item: Pending) => {
      const handshake = handshakeRef.current
      if (!handshake) return
      const message = pongs[String(item.id)] || 'pong from host'
      const result = { message }
      handshake.respond(item.id, result)
      log.push({
        intent: 'positive',
        label: 'respond',
        requestId: item.id,
        detail: result,
      })
      setPending((prev) => prev.filter((p) => p.id !== item.id))
      setPongs((prev) => {
        const next = { ...prev }
        delete next[String(item.id)]
        return next
      })
    },
    [log, pongs],
  )

  const reject = useCallback(
    (item: Pending) => {
      const handshake = handshakeRef.current
      if (!handshake) return
      const message = pongs[String(item.id)] || 'rejected by host'
      const error = { code: -32000, message }
      handshake.reject(item.id, error)
      log.push({
        intent: 'negative',
        label: 'reject',
        requestId: item.id,
        detail: error,
      })
      setPending((prev) => prev.filter((p) => p.id !== item.id))
      setPongs((prev) => {
        const next = { ...prev }
        delete next[String(item.id)]
        return next
      })
    },
    [log, pongs],
  )

  return (
    <div className="flex h-screen flex-col bg-surface">
      {pending.length === 0 ? (
        <div className="flex items-center gap-[8px] p-[12px]">
          <Tag intent={stateIntent[state]} dot>
            {state}
          </Tag>
          <span className="copy-13 text-foreground-tertiary">no pending requests</span>
        </div>
      ) : (
        pending.map((item) => {
          const key = String(item.id)
          return (
            <div
              key={key}
              className="flex items-center gap-[8px] border-b border-border px-[12px] py-[8px] min-w-0"
            >
              <span className="copy-13 flex-1 truncate text-foreground min-w-0">
                {consumerMessage(item.params)}
              </span>
              <Input
                size="small"
                value={pongs[key] ?? ''}
                onChange={(event) =>
                  setPongs((prev) => ({ ...prev, [key]: event.target.value }))
                }
                placeholder="pong from host"
              />
              <Button variant="primary" size="small" onClick={() => respond(item)}>
                respond
              </Button>
              <Button variant="secondary" size="small" onClick={() => reject(item)}>
                reject
              </Button>
            </div>
          )
        })
      )}
    </div>
  )
}

function consumerMessage(params: unknown): string {
  if (Array.isArray(params) && params.length > 0) {
    const first = params[0]
    if (first && typeof first === 'object' && 'message' in first) {
      const value = (first as { message: unknown }).message
      if (typeof value === 'string') return value
    }
  }
  return ''
}

function detectPeer(): { window: Window; origin: string | undefined } | undefined {
  const url = new URL(window.location.href)
  const origin = url.searchParams.get('consumerOrigin') ?? undefined
  if (window.opener) return { window: window.opener as Window, origin }
  if (window.parent !== window) return { window: window.parent, origin }
  return undefined
}

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
createRoot(root).render(<App />)
