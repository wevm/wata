/**
 * Consumer-side React app for the postMessage playground.
 *
 * Runs on its own dev server (5181) and talks to the host running on
 * a different origin (5182) — exercising real cross-origin postMessage
 * behavior. Layout: app header (title + iframe/popup toggle) above two
 * macOS-style window chromes side-by-side. In iframe mode the host
 * renders inside the right chrome's body; in popup mode the popup is
 * positioned over the right chrome's screen rect. The host renders its
 * own log, so the consumer only shows its own log here.
 */

import { useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Input, Tag } from 'regen-ui'
import { Wata, PostMessage, postMessage } from 'wata'

import * as Log from './Log.js'
import { Window } from './Window.js'
import './styles.css'

const hostOrigin = 'http://localhost:5182'

type Mount = 'popup' | 'iframe'

type State = 'idle' | 'open' | 'closed' | 'error'

const stateIntent: Record<State, Log.Intent> = {
  idle: 'neutral',
  open: 'positive',
  closed: 'neutral',
  error: 'negative',
}

function App() {
  const [mount, setMount] = useState<Mount>('iframe')
  const [state, setState] = useState<State>('idle')
  const [message, setMessage] = useState('')
  const log = Log.useLog()
  const wataRef = useRef<Wata.Consumer | undefined>(undefined)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const hostChromeRef = useRef<HTMLDivElement | null>(null)

  const ensureWata = useCallback(() => {
    if (wataRef.current) return wataRef.current

    let cleanup = () => {}
    const wata = Wata.create({
      transports: [
        postMessage<Window>({
          host: hostOrigin,
          target: ({ host }) => {
            if (!host) throw new Error('host is required')
            const url = new URL(host)
            // Convey our origin out of band so the host can pin it (spec §3.1).
            url.searchParams.set('origin', location.origin)
            if (mount === 'popup') {
              const popup = window.open(
                url.toString(),
                'wata-host',
                popupFeatures(hostChromeRef.current),
              )
              if (!popup) throw new PostMessage.PopupBlockedError('window.open returned null')
              cleanup = () => popup.close()
              return popup
            }
            const iframe = iframeRef.current
            if (!iframe) throw new Error('iframe mount missing')
            iframe.src = url.toString()
            return new Promise<Window>((resolve, reject) => {
              iframe.addEventListener(
                'load',
                () => {
                  const win = iframe.contentWindow
                  if (win) resolve(win)
                  else reject(new Error('iframe.contentWindow was null'))
                },
                { once: true },
              )
            })
          },
          close: (handle: Window) => {
            if (mount === 'popup' && handle.close) handle.close()
            cleanup()
            const iframe = iframeRef.current
            if (iframe) iframe.removeAttribute('src')
          },
        }),
      ],
    })
    wata.on('open', () => {
      setState('open')
      log.push({ intent: 'positive', label: 'open' })
    })
    wata.on('close', (cause) => {
      setState('closed')
      wataRef.current = undefined
      log.push({ intent: 'neutral', label: 'close', detail: cause })
    })
    wata.on('error', (error) => {
      setState('error')
      log.push({ intent: 'negative', label: 'error', detail: error })
    })

    wataRef.current = wata
    return wata
  }, [log, mount])

  const setup = useCallback(async () => {
    log.push({ intent: 'accent', label: 'setup' })
    try {
      await ensureWata().start()
    } catch (error) {
      log.push({ intent: 'negative', label: 'setup threw', detail: error })
    }
  }, [ensureWata, log])

  const send = useCallback(async () => {
    const id = nextRequestId()
    const params = [{ message: message || 'hello from consumer' }]
    log.push({ intent: 'accent', label: 'send', requestId: id, detail: params })
    try {
      const response = await ensureWata().send({ id, method: 'ping', params })
      log.push({
        intent: 'positive',
        label: 'result',
        requestId: response.id,
        detail: response.result,
      })
    } catch (error) {
      log.push({ intent: 'negative', label: 'send threw', requestId: id, detail: error })
    }
  }, [ensureWata, log, message])

  return (
    <div className="flex flex-col bg-background">
      <header className="flex items-center gap-[8px] border-b border-border px-[14px] py-[10px]">
        <strong className="copy-13">wata · postMessage · consumer</strong>
        <span className="ml-auto inline-flex gap-[4px]">
          <Button
            variant={mount === 'iframe' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setMount('iframe')}
          >
            iframe
          </Button>
          <Button
            variant={mount === 'popup' ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setMount('popup')}
          >
            popup
          </Button>
        </span>
      </header>

      <main className="grid h-[260px] grid-cols-2 gap-[16px] p-[16px]">
        <Window
          title="consumer"
          subtitle={
            <Tag intent={stateIntent[state]} dot>
              {state}
            </Tag>
          }
        >
          <div className="flex flex-1 flex-col gap-[8px] p-[12px]">
            <Input
              size="small"
              label="ping message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="hello from consumer"
            />
            <div className="flex items-center gap-[6px]">
              <Button variant="primary" size="small" onClick={() => void send()}>
                send
              </Button>
            </div>
          </div>
        </Window>

        <Window
          ref={hostChromeRef}
          title="host"
          subtitle={
            <Tag intent={stateIntent[state]} dot>
              {state}
            </Tag>
          }
        >
          {state !== 'open' && (
            <div className="flex items-center gap-[6px] border-b border-border p-[12px]">
              <Button variant="primary" size="small" onClick={() => void setup()}>
                setup
              </Button>
            </div>
          )}
          <div className="flex-1 min-h-0">
            {mount === 'iframe' ? (
              <iframe ref={iframeRef} title="wata-host" className="block h-full w-full border-0" />
            ) : (
              <p className="m-auto copy-13 text-foreground-tertiary">
                host opens in a popup over this chrome
              </p>
            )}
          </div>
        </Window>
      </main>

      <section className="border-t border-border p-[16px]">
        <div className="copy-13 mb-[8px] font-medium text-foreground-secondary">consumer log</div>
        <Log.LogView log={log} />
      </section>
    </div>
  )
}

let requestCounter = 0
function nextRequestId(): number {
  requestCounter += 1
  return requestCounter
}

/**
 * Build a `window.open` features string that places the popup at the
 * screen-space rect of the host chrome, so the popup visually replaces
 * the right pane while the demo runs. Falls back to a sensible default
 * if the chrome ref isn't mounted yet.
 */
function popupFeatures(chrome: HTMLDivElement | null): string {
  if (!chrome) return 'popup=1,width=420,height=560'
  const rect = chrome.getBoundingClientRect()
  const left = Math.round(window.screenX + rect.left)
  const top = Math.round(window.screenY + rect.top + (window.outerHeight - window.innerHeight))
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  return `popup=1,left=${left},top=${top},width=${width},height=${height}`
}

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
createRoot(root).render(<App />)
