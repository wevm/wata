/**
 * Host-side React app for the postMessage playground.
 *
 * Runs on its own dev server (5182) so it lives on a different origin
 * from the consumer (5181) — exercising real cross-origin postMessage
 * behavior. Detects the consumer (iframe parent or popup opener), opens
 * a `Handshake` session, and lets the user manually respond/reject each
 * inbound request via a text input + buttons. Renders its own log
 * directly in the host window since cross-origin pages can't share a
 * `BroadcastChannel`.
 */

import { Handshake, postMessage } from 'wata/host'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Input, Tag } from 'regen-ui'

import * as Log from './Log.js'

import './styles.css'

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
  const log = Log.useLog()
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
        target: () => peer.window,
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
    <div className="flex flex-col bg-background">
      <header className="flex items-center gap-[8px] border-b border-border px-[14px] py-[10px]">
        <strong className="copy-13">wata · postMessage · host</strong>
        <Tag intent={stateIntent[state]} dot>
          {state}
        </Tag>
      </header>

      <section className="flex flex-col">
        {pending.length === 0 ? (
          <div className="copy-13 px-[14px] py-[12px] text-foreground-tertiary">
            no pending requests
          </div>
        ) : (
          pending.map((item) => {
            const key = String(item.id)
            return (
              <div
                key={key}
                className="flex items-center gap-[8px] border-b border-border px-[14px] py-[8px] min-w-0"
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
      </section>

      <section className="border-t border-border p-[16px]">
        <div className="copy-13 mb-[8px] font-medium text-foreground-secondary">host log</div>
        <Log.LogView log={log} />
      </section>
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
