/**
 * Consumer-side React app for the postMessage playground.
 *
 * Layout: app header (title + iframe/popup toggle) above two macOS-style
 * window chromes side-by-side — consumer log on the left, host on the
 * right — with a vertical strip of `send()` / `notify()` controls between
 * them. In iframe mode the host renders inside the right chrome's body;
 * in popup mode the right chrome shows a placeholder and `window.open()`
 * positions the popup over the chrome's screen rect.
 */

import { Handshake, PostMessage, postMessage } from 'handshakes'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Input, Tag } from 'regen-ui'

import * as Log from './Log.js'
import { Window } from './Window.js'

import './styles.css'

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
  const hostLog = Log.useLog()
  const handshakeRef = useRef<Handshake.Consumer | undefined>(undefined)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const hostChromeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const channel = new BroadcastChannel('handshakes-host-log')
    channel.onmessage = (event) => {
      hostLog.push(event.data as Omit<Log.Entry, 'id' | 'time'>)
    }
    return () => channel.close()
  }, [hostLog])

  const ensureHandshake = useCallback(() => {
    if (handshakeRef.current) return handshakeRef.current

    let cleanup = () => {}
    const transport = postMessage<Window>({
      targetOrigin: window.location.origin,
      open: () => {
        const url = new URL('./host.html', window.location.href)
        url.searchParams.set('consumerOrigin', window.location.origin)
        if (mount === 'popup') {
          const popup = window.open(url.toString(), 'handshakes-host', popupFeatures(hostChromeRef.current))
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
    })

    const handshake = Handshake.create({ transport })
    handshake.on('open', () => {
      setState('open')
      log.push({ intent: 'positive', label: 'open' })
    })
    handshake.on('close', (cause) => {
      setState('closed')
      handshakeRef.current = undefined
      log.push({ intent: 'neutral', label: 'close', detail: cause })
    })
    handshake.on('error', (error) => {
      setState('error')
      log.push({ intent: 'negative', label: 'error', detail: error })
    })

    handshakeRef.current = handshake
    return handshake
  }, [log, mount])

  const setup = useCallback(async () => {
    log.push({ intent: 'accent', label: 'setup' })
    try {
      await ensureHandshake().start()
    } catch (error) {
      log.push({ intent: 'negative', label: 'setup threw', detail: error })
    }
  }, [ensureHandshake, log])

  const send = useCallback(async () => {
    const id = nextRequestId()
    const params = [{ message: message || 'hello from consumer' }]
    log.push({ intent: 'accent', label: 'send', requestId: id, detail: params })
    try {
      const response = await ensureHandshake().send({ id, method: 'ping', params })
      log.push({
        intent: 'positive',
        label: 'result',
        requestId: response.id,
        detail: response.result,
      })
    } catch (error) {
      log.push({ intent: 'negative', label: 'send threw', requestId: id, detail: error })
    }
  }, [ensureHandshake, log, message])

  return (
    <div className="flex flex-col bg-background">
      <header className="flex items-center gap-[8px] border-b border-border px-[14px] py-[10px]">
        <strong className="copy-13">handshakes · postMessage</strong>
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
              <iframe
                ref={iframeRef}
                title="handshakes-host"
                className="block h-full w-full border-0"
              />
            ) : (
              <p className="m-auto copy-13 text-foreground-tertiary">
                host opens in a popup over this chrome
              </p>
            )}
          </div>
        </Window>
      </main>

      <section className="grid grid-cols-2 gap-[16px] border-t border-border p-[16px]">
        <div>
          <div className="copy-13 mb-[8px] font-medium text-foreground-secondary">consumer log</div>
          <Log.LogView log={log} />
        </div>
        <div>
          <div className="copy-13 mb-[8px] font-medium text-foreground-secondary">host log</div>
          <Log.LogView log={hostLog} />
        </div>
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
