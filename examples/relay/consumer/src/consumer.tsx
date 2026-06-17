/**
 * Web consumer for the relay example — plays the "web app".
 *
 * Sending the first request lazily starts the relay transport: the
 * consumer slot is locked, and the pairing uri surfaces as a QR code
 * (scan-friendly) plus copyable text (simulator-friendly). Once the
 * host app connects and the encrypted session keys, the buffered
 * request flushes and the result lands in the log. The session stays
 * open — keep sending pings and watch notifications the host pushes.
 *
 * The relay address defaults to the page's own hostname so a page
 * opened via a LAN address hands the phone a reachable relay too.
 */

import QRCode from 'qrcode'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Wata, relay } from 'wata'

const relayUrl = import.meta.env.VITE_RELAY_URL ?? `http://${location.hostname}:4860`

const wata = Wata.create({
  // `allowPrivateNetwork` permits the HTTP `relayUrl` on a LAN address
  // (e.g. `http://192.168.x.x:4860`) so a phone can reach the dev
  // machine. Production relays are HTTPS and need no opt-in.
  transports: [relay({ allowPrivateNetwork: true, url: relayUrl })],
})

type Prompt = {
  qr: string
  uri: string
}

function App() {
  const [lines, setLines] = useState<readonly string[]>([])
  const [prompt, setPrompt] = useState<Prompt | undefined>(undefined)
  const session = React.useRef<Awaited<ReturnType<typeof wata.start>> | undefined>(undefined)

  function append(line: string) {
    setLines((lines) => [...lines, line])
  }

  useEffect(
    () => () => {
      void session.current?.close()
    },
    [],
  )

  async function start() {
    if (session.current) return session.current
    const next = await wata.start()
    session.current = next
    const subscriptions = [
      next.onPrompt(async ({ uri }) => {
        const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 })
        setPrompt({ qr, uri })
      }),
      next.onNotification((event) =>
        append(`notification: ${event.method} ${JSON.stringify(event.params)}`),
      ),
      next.onClose((cause) => {
        setPrompt(undefined)
        session.current = undefined
        append(cause ? `closed: ${cause.message}` : 'closed')
      }),
      next.onError((error) => append(`error: ${error.message}`)),
    ]
    next.onClose(() => {
      for (const subscription of subscriptions) subscription.abort()
    })
    return next
  }

  async function send() {
    append('sending ping…')
    try {
      const next = await start()
      const { result } = await next.send({ method: 'ping', params: [{ from: 'web' }] })
      setPrompt(undefined)
      append(`result: ${JSON.stringify(result)}`)
    } catch (error) {
      append(`${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  return (
    <main>
      <h1>relay example — consumer</h1>
      <p>
        relay: <code>{relayUrl}</code>
      </p>
      <button onClick={() => void send()} type="button">
        send ping
      </button>
      {prompt ? (
        <section>
          <h2>pair your device</h2>
          <img alt="pairing QR code" src={prompt.qr} />
          <p>or paste into the host app:</p>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{prompt.uri}</pre>
          <button onClick={() => void navigator.clipboard.writeText(prompt.uri)} type="button">
            copy pairing uri
          </button>
        </section>
      ) : undefined}
      <section>
        <h2>log</h2>
        <pre>{lines.join('\n')}</pre>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
