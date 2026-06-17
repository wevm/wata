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
 * `useSession` from `wata/react` owns the lifecycle: with `start: true` it
 * starts the session on mount, forwards events to callbacks (the pairing
 * link arrives via `onPrompt`), exposes the live `session` to send on, and
 * closes on unmount.
 *
 * The relay address defaults to the page's own hostname so a page
 * opened via a LAN address hands the phone a reachable relay too.
 */

import QRCode from 'qrcode'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Wata, relay } from 'wata'
import { useSession } from 'wata/react'

const relayUrl = import.meta.env.VITE_RELAY_URL ?? `http://${location.hostname}:4860`

const wata = Wata.create({
  // `allowPrivateNetwork` permits the HTTP `relayUrl` on a LAN address
  // (e.g. `http://192.168.x.x:4860`) so a phone can reach the dev
  // machine. Production relays are HTTPS and need no opt-in.
  transports: [relay({ allowPrivateNetwork: true, url: relayUrl })],
})

type Pairing = {
  qr: string
  uri: string
}

function App() {
  const [lines, setLines] = useState<readonly string[]>([])
  const [pairing, setPairing] = useState<Pairing | undefined>(undefined)

  function append(line: string) {
    setLines((lines) => [...lines, line])
  }

  const { session } = useSession(wata, {
    start: true,
    onClose: (cause) => {
      setPairing(undefined)
      append(cause ? `closed: ${cause.message}` : 'closed')
    },
    onError: (error) => append(`error: ${error.message}`),
    onNotification: (event) =>
      append(`notification: ${event.method} ${JSON.stringify(event.params)}`),
    onPrompt: async ({ uri }) =>
      setPairing({ qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }), uri }),
  })

  async function send() {
    if (!session) return
    append('sending ping…')
    try {
      const { result } = await session.send({ method: 'ping', params: [{ from: 'web' }] })
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
      <button disabled={!session} onClick={() => void send()} type="button">
        send ping
      </button>
      {pairing ? (
        <section>
          <h2>pair your device</h2>
          <img alt="pairing QR code" src={pairing.qr} />
          <p>or paste into the host app:</p>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{pairing.uri}</pre>
          <button onClick={() => void navigator.clipboard.writeText(pairing.uri)} type="button">
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
