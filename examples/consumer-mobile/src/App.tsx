/**
 * Mobile consumer — directory-driven.
 *
 * Queries the directory (`examples/directory`) for wallets and renders the
 * list. Tapping a wallet fetches that origin's `host.json` and chooses a
 * transport from what it advertises:
 *
 *   • a `mobile-web-auth` binding (web wallet) → `mobileWebAuth` (system
 *     browser auth session)
 *   • a `mobile-link` binding (mobile wallet) → `mobileLink` (app-to-app deep
 *     links); the callback deep link is routed back in via `session.handleUrl`
 *
 * One `Wata` instance (see `wata.ts`) carries both transports.
 */

import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import * as React from 'react'
import { Button, ScrollView, Text, View } from 'react-native'
import { Discovery } from 'wata'

import { directoryUrl } from './config.js'
import { wata } from './wata.js'

type Session = Awaited<ReturnType<typeof wata.mobileLink.start>>
type Wallet = { icon?: string; id: string; name: string; origin: string }

/** A mobile-link callback always carries `message` + `version` query params. */
function isMobileLinkCallback(url: string): boolean {
  try {
    const { searchParams } = new URL(url)
    return searchParams.has('message') && searchParams.has('version')
  } catch {
    return false
  }
}

export default function App() {
  const [log, setLog] = React.useState('loading directory…')
  const [wallets, setWallets] = React.useState<readonly Wallet[]>([])
  const mobileLinkRef = React.useRef<Session | undefined>(undefined)

  React.useEffect(() => {
    fetchWallets()
      .then((items) => {
        setWallets(items)
        setLog(`${items.length} wallet(s) — pick one`)
      })
      .catch((cause: Error) => setLog(`directory error: ${cause.message}`))

    const handle = (url: string) => {
      if (isMobileLinkCallback(url)) void mobileLinkRef.current?.handleUrl(url)
    }
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url))
    void Linking.getInitialURL().then((url) => {
      if (url) handle(url)
    })
    return () => subscription.remove()
  }, [])

  async function pick(wallet: Wallet) {
    setLog(`selected ${wallet.name}…`)
    try {
      const document = await Discovery.fetchHost(wallet.origin)
      const mobileLinkBinding = document.transports['mobile-link']
      if (document.transports['mobile-web-auth']) return connectWeb(wallet)
      if (mobileLinkBinding) return connectMobile(wallet, mobileLinkBinding.scheme)
      setLog(`${wallet.name} advertises no mobile transport`)
    } catch (cause) {
      setLog(`${(cause as Error).name}: ${(cause as Error).message}`)
    }
  }

  function connectWeb(wallet: Wallet) {
    setLog(`opening ${wallet.name}…`)
    wata.mobileWebAuth
      .start({
        host: wallet.origin,
        openAuthSession: async ({ authorizationUrl, callback }) => {
          const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, callback)
          return result.type === 'success' ? result.url : undefined
        },
      })
      .send({ method: 'eth_requestAccounts', params: [] })
      .then((response) => setLog(`connected: ${JSON.stringify(response.result)}`))
      .catch((cause: Error) => setLog(`${cause.name}: ${cause.message}`))
  }

  function connectMobile(wallet: Wallet, scheme: string) {
    setLog(`opening ${wallet.name}…`)
    let session = mobileLinkRef.current
    if (!session) {
      session = wata.mobileLink.start({ host: wallet.origin, target: scheme })
      mobileLinkRef.current = session
      session.onClose((cause) => setLog(`closed${cause ? `: ${cause.message}` : ''}`))
      session.onError((cause) => setLog(`error: ${cause.name}: ${cause.message}`))
    }
    session
      .send({ method: 'ping', params: [] })
      .then((response) => setLog(`result: ${JSON.stringify(response.result)}`))
      .catch((cause: Error) => setLog(`${cause.name}: ${cause.message}`))
  }

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 72 }}>
      <Text style={{ fontSize: 20, fontWeight: '600' }}>consumer-mobile</Text>
      {wallets.map((wallet) => (
        <Button key={wallet.origin} onPress={() => void pick(wallet)} title={wallet.name} />
      ))}
      <ScrollView style={{ flex: 1 }}>
        <Text selectable>{log}</Text>
      </ScrollView>
    </View>
  )
}

/** Query the directory for indexed wallets. */
async function fetchWallets(): Promise<readonly Wallet[]> {
  const response = await fetch(`${directoryUrl}/v1/hosts`)
  if (!response.ok) throw new Error(`directory responded ${response.status}`)
  const body = (await response.json()) as { items: readonly Wallet[] }
  return body.items
}
