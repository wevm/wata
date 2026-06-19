/**
 * walletConnect example -- discover WalletConnect wallets via the directory,
 * then connect to one.
 *
 * On mount it lists wallets from the WalletConnect registry (Reown Explorer)
 * and opens a `walletConnect` session with no target, so `prompt.uri` is the
 * universal `wc:` URI (a QR any wallet can scan). Selecting a wallet switches
 * the session -- `close()` then `start({ target: wallet.transports.walletConnect })`
 * -- so `prompt.uri` becomes that wallet's deep link. Scanning the QR or tapping
 * the link approves the
 * session; `eth_accounts` then returns the accounts.
 */

import { Cuer } from 'cuer'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Directory, Wata } from 'wata'
import { useSession } from 'wata/react'
import { walletConnect } from 'wata/walletConnect'

const projectId = 'ba7804e457fbb5f1375cbdc14e679617'

const wata = Wata.create({ transports: [walletConnect({ chains: [1], projectId })] })

function App() {
  const [wallets, setWallets] = useState<readonly Directory.Item[]>([])
  const [selected, setSelected] = useState<Directory.Item | undefined>(undefined)
  const [lines, setLines] = useState<readonly string[]>([])
  const append = (line: string) => setLines((current) => [...current, line])

  const { close, prompt, session, start } = useSession(wata, {
    onClose: (cause) => append(cause ? `closed: ${cause.message}` : 'closed'),
    onError: (error) => append(`error: ${error.message}`),
    onNotification: (event) =>
      append(`notification: ${event.method} ${JSON.stringify(event.params)}`),
  })

  // Discovery + open the universal pairing on mount.
  useEffect(() => {
    Directory.query({
      transports: ['walletConnect'],
      walletConnect: { entries: 20, page: 1, projectId },
    })
      .then(({ items }) => setWallets(items))
      .catch((error: Error) => append(`directory error: ${error.message}`))

    start().catch((error: Error) => append(`start error: ${error.message}`))
  }, [])

  async function select(wallet?: Directory.Item) {
    setSelected(wallet)
    try {
      await close()
      await start({ target: wallet?.transports.walletConnect })
    } catch (error) {
      append(`${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  async function ethAccounts() {
    if (!session) return
    try {
      const { result } = await session.send({
        context: { chainId: 1 },
        method: 'eth_accounts',
        params: [],
      })
      append(`accounts: ${JSON.stringify(result)}`)
    } catch (error) {
      append(`${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  return (
    <main>
      <h1>walletConnect example</h1>
      {prompt ? (
        <section>
          <h2>{selected ? `open ${selected.name}` : 'scan with any wallet'}</h2>
          <Cuer size={240} value={prompt.uri} />
          {selected ? (
            <p>
              <a href={prompt.uri}>open {selected.name}</a>{' '}
              <button onClick={() => void select(undefined)} type="button">
                ← any wallet
              </button>
            </p>
          ) : null}
          <p>
            <button disabled={!session} onClick={() => void ethAccounts()} type="button">
              eth_accounts
            </button>
          </p>
          <h3>wallets ({wallets.length})</h3>
          <ul>
            {wallets.map((wallet) => (
              <li key={wallet.id}>
                <button onClick={() => void select(wallet)} type="button">
                  {wallet.icon ? (
                    <img alt="" height={20} src={wallet.icon} width={20} />
                  ) : undefined}{' '}
                  {wallet.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p>preparing…</p>
      )}
      <section>
        <h2>log</h2>
        <pre>{lines.join('\n')}</pre>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
