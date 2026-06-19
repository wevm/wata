/**
 * Mobile wallet (host) — accepts connections from every consumer:
 *
 *   mobileLink → for `consumer-mobile` (app-to-app deep links)
 *   relay      → for `consumer-web` / `consumer-cli` (paste a pairing uri)
 *
 * One `Wata` instance carries both transports. The `mobileLink` session
 * listens for incoming deep links from mount; the `relay` session starts once
 * a pairing uri is pasted. Both funnel inbound requests into one approval queue.
 */

import * as Linking from 'expo-linking'
import * as React from 'react'
import { Button, ScrollView, Text, TextInput, View } from 'react-native'
import { Identity, type Session, Wata, mobileLink, relay } from 'wata/host'

import { hostIdentityPrivateKey, hostOrigin, hostScheme } from './config.js'

type MobileLinkSession = Awaited<ReturnType<typeof host.mobileLink.start>>

const host = Wata.create({
  baseUrl: hostOrigin,
  identity: Identity.fromPrivateKey(hostIdentityPrivateKey),
  meta: { name: 'Wata Wallet' },
  transports: [
    // `allowPrivateNetwork` lets the host pair from a LAN pairing link when
    // scanning the dev consumer. Production relays are HTTPS and need no opt-in.
    relay({ allowPrivateNetwork: true, receive: 'poll' }),
    mobileLink({
      async openLink(url) {
        await Linking.openURL(url)
      },
      scheme: hostScheme,
    }),
  ],
})

export default function App() {
  const [log, setLog] = React.useState('ready — waiting for mobileLink requests')
  const [pending, setPending] = React.useState<readonly Session.RequestEvent[]>([])
  const [uri, setUri] = React.useState('')
  const mobileLinkRef = React.useRef<MobileLinkSession | undefined>(undefined)

  const append = React.useCallback((line: string) => setLog((log) => `${log}\n${line}`), [])

  const onRequest = React.useCallback(
    (event: Session.RequestEvent) => {
      append(`request: ${event.method} ${JSON.stringify(event.params)} — approve or deny`)
      setPending((queue) => [...queue, event])
    },
    [append],
  )

  React.useEffect(() => {
    const session = host.mobileLink.start()
    mobileLinkRef.current = session
    session.onClose((cause) => append(`closed${cause ? `: ${cause.message}` : ''}`))
    session.onError((cause) => append(`error: ${cause.name}: ${cause.message}`))
    session.onRequest(onRequest)
    const subscription = Linking.addEventListener('url', ({ url }) => {
      void mobileLinkRef.current?.handleUrl(url)
    })
    void Linking.getInitialURL().then((url) => {
      if (url) void mobileLinkRef.current?.handleUrl(url)
    })
    return () => subscription.remove()
  }, [append, onRequest])

  function settle(event: Session.RequestEvent) {
    setPending((queue) => queue.filter((queued) => queued !== event))
  }

  function approve(event: Session.RequestEvent) {
    settle(event)
    if (event.method === 'echo') void event.respond(event.params)
    else void event.respond({ message: 'pong from mobile' })
    append(`approved: ${event.method}`)
  }

  function reject(event: Session.RequestEvent) {
    settle(event)
    void event.reject({ code: 4001, message: 'User rejected the request.' })
    append(`rejected: ${event.method}`)
  }

  async function connectRelay() {
    try {
      append('connecting relay…')
      const session = await host.relay.start({ uri: uri.trim() })
      session.onClose((cause) => append(`closed${cause ? `: ${cause.message}` : ''}`))
      session.onError((cause) => append(`error: ${cause.name}: ${cause.message}`))
      session.onRequest(onRequest)
      setUri('')
      append('relay connected')
    } catch (error) {
      append(`${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 72 }}>
      <Text style={{ fontSize: 20, fontWeight: '600' }}>host-mobile (wallet)</Text>

      {pending.map((event, index) => (
        <View key={`${index}-${event.method}`} style={{ gap: 4 }}>
          <Text selectable>{`Approve ${event.method}? ${JSON.stringify(event.params)}`}</Text>
          <Button onPress={() => approve(event)} title="Approve" />
          <Button color="#b00020" onPress={() => reject(event)} title="Deny" />
        </View>
      ))}

      <Text>Pair a web/CLI consumer (relay):</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        onChangeText={setUri}
        placeholder="urpc://?consumer_pubkey=…"
        style={{ borderWidth: 1, minHeight: 72, padding: 8 }}
        value={uri}
      />
      <Button disabled={!uri.trim()} onPress={() => void connectRelay()} title="Connect relay" />

      <ScrollView style={{ flex: 1 }}>
        <Text selectable>{log}</Text>
      </ScrollView>
    </View>
  )
}
