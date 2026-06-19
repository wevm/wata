/**
 * Web consumer — directory-driven.
 *
 * On load it queries the directory (`examples/directory`) for wallets and
 * renders the list. Two ways to connect:
 *
 *   1. Universal QR (always shown) — pairs via `relay`. Any mobile wallet can
 *      scan it, whether or not it is in the directory.
 *   2. Pick a wallet from the directory — the consumer fetches that origin's
 *      `host.json` and chooses a transport from what it advertises:
 *        • a `window` binding (web wallet) → `postMessage` (opens the wallet's
 *          host page in a popup)
 *        • otherwise (mobile wallet) → `relay` (use the universal QR)
 *
 * One `Wata` instance carries both transports; the picked wallet decides which
 * one drives `send`.
 */

import { Cuer } from 'cuer'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Discovery, PostMessage, Wata, postMessage, relay } from 'wata'

import { directoryUrl, relayUrl } from './config.js'

/** A wallet row as returned by the directory's `GET /v1/hosts`. */
type Wallet = {
  icon?: string
  id: string
  name: string
  origin: string
}

/** Common surface both transport sessions share. */
type Session = Pick<
  Awaited<ReturnType<typeof wata.relay.start>>,
  'close' | 'onClose' | 'onError' | 'onNotification' | 'send'
>

const wata = Wata.create({
  transports: [
    postMessage({
      // Runs on the first `send` (inside the click gesture) so the popup
      // isn't blocked. The consumer conveys its origin out of band (spec §3.1).
      target({ host }) {
        const url = `${host}?origin=${encodeURIComponent(location.origin)}`
        const popup = window.open(url, 'wata-host', 'popup=1,width=420,height=360')
        if (!popup) throw new PostMessage.PopupBlockedError('popup was blocked')
        return popup
      },
    }),
    // `allowPrivateNetwork` permits an http relay on a LAN address so a phone
    // can reach the dev machine. Production relays are HTTPS and need no opt-in.
    relay({ allowPrivateNetwork: true, url: relayUrl }),
  ],
})

/** Query the directory for indexed wallets. */
async function fetchWallets(): Promise<readonly Wallet[]> {
  const response = await fetch(`${directoryUrl}/v1/hosts`)
  if (!response.ok) throw new Error(`directory responded ${response.status}`)
  const body = (await response.json()) as { items: readonly Wallet[] }
  return body.items
}

function App() {
  const [lines, setLines] = useState<readonly string[]>([])
  const [wallets, setWallets] = useState<readonly Wallet[]>([])
  const [session, setSession] = useState<Session | undefined>(undefined)
  const [uri, setUri] = useState<string | undefined>(undefined)

  function append(line: string) {
    setLines((lines) => [...lines, line])
  }

  // Load the directory and bring up the universal relay QR on mount.
  useEffect(() => {
    fetchWallets()
      .then((items) => {
        setWallets(items)
        append(`directory: ${items.length} wallet(s)`)
      })
      .catch((error: Error) => append(`directory error: ${error.message}`))

    const relaySession = wata.relay.start()
    wire(relaySession)
    relaySession.onPrompt(({ uri }) => setUri(uri))
    setSession(relaySession)
    append('universal QR ready — scan from any mobile wallet')
    return () => void relaySession.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function wire(next: Session) {
    next.onClose((cause) => append(cause ? `closed: ${cause.message}` : 'closed'))
    next.onError((error) => append(`error: ${error.message}`))
    next.onNotification((event) =>
      append(`notification: ${event.method} ${JSON.stringify(event.params)}`),
    )
  }

  async function pick(wallet: Wallet) {
    append(`selected ${wallet.name}`)
    try {
      const document = await Discovery.fetchHost(wallet.origin)
      const windowBinding = document.transports.window
      if (windowBinding) {
        // Web wallet → postMessage. Start a session against its host page.
        append(`${wallet.name} speaks postMessage → opening ${windowBinding.url}`)
        const next = await wata.postMessage.start({ host: windowBinding.url })
        wire(next)
        setSession(next)
        return
      }
      // Mobile wallet → relay. The universal QR is already live; point to it.
      append(`${wallet.name} is mobile → scan the universal QR with it`)
    } catch (error) {
      append(`${(error as Error).name}: ${(error as Error).message}`)
    }
  }

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
      <h1>consumer-web</h1>

      <section>
        <h2>scan with any mobile wallet</h2>
        {uri ? (
          <div style={{ width: 240 }}>
            <Cuer value={uri} />
          </div>
        ) : (
          <p>generating QR…</p>
        )}
      </section>

      <section>
        <h2>directory</h2>
        {wallets.length === 0 ? (
          <p>no wallets found (is the directory running?)</p>
        ) : (
          <ul>
            {wallets.map((wallet) => (
              <li key={wallet.origin}>
                <button onClick={() => void pick(wallet)} type="button">
                  {wallet.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <button disabled={!session} onClick={() => void send()} type="button">
          send ping
        </button>
      </section>

      <section>
        <h2>log</h2>
        <pre>{lines.join('\n')}</pre>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
