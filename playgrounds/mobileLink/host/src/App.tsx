import * as Linking from 'expo-linking'
import * as React from 'react'
import { Button, ScrollView, Text, View } from 'react-native'
import { Identity, Wata, mobileLink } from 'wata/host'

import { hostIdentityPrivateKey, hostOrigin, hostScheme } from './config.js'

const host = Wata.create({
  baseUrl: hostOrigin,
  identity: Identity.fromPrivateKey(hostIdentityPrivateKey),
  meta: { name: 'Wata Wallet' },
  transports: [
    mobileLink({
      async openLink(url) {
        await Linking.openURL(url)
      },
      scheme: hostScheme,
    }),
  ],
})

type Session = Awaited<ReturnType<typeof host.mobileLink.start>>
type Pending = Parameters<Parameters<Session['onRequest']>[0]>[0]

export default function App() {
  const [log, setLog] = React.useState('waiting for requests...')
  const sessionRef = React.useRef<Session | undefined>(undefined)

  // Incoming requests are held here until the user approves or rejects them.
  const [pending, setPending] = React.useState<readonly Pending[]>([])

  React.useEffect(() => {
    let onClose: AbortController | undefined
    let onError: AbortController | undefined
    let onRequest: AbortController | undefined
    const session = host.mobileLink.start()
    sessionRef.current = session
    onClose = session.onClose((cause) => setLog(`closed${cause ? `: ${cause.message}` : ''}`))
    onError = session.onError((cause) => setLog(`error: ${cause.name}: ${cause.message}`))
    onRequest = session.onRequest((event) => {
      setLog(`request: ${event.method} ${JSON.stringify(event.params)} — awaiting approval`)
      setPending((queue) => [...queue, event])
    })
    const subscription = Linking.addEventListener('url', ({ url }) => {
      void sessionRef.current?.handleUrl(url)
    })
    void Linking.getInitialURL().then((url) => {
      if (url) void sessionRef.current?.handleUrl(url)
    })
    return () => {
      subscription.remove()
      onClose?.abort()
      onError?.abort()
      onRequest?.abort()
    }
  }, [])

  function approve(event: Pending) {
    setPending((queue) => queue.filter((entry) => entry !== event))
    if (event.method === 'ping') void event.respond('pong')
    else if (event.method === 'echo') void event.respond(event.params)
    else void event.reject({ code: -32601, message: `unknown method: ${event.method}` })
    setLog(`approved: ${event.method}`)
  }

  function reject(event: Pending) {
    setPending((queue) => queue.filter((entry) => entry !== event))
    void event.reject({ code: 4001, message: 'User rejected the request.' })
    setLog(`rejected: ${event.method}`)
  }

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 72 }}>
      <Text style={{ fontSize: 20, fontWeight: '600' }}>mobileLink host (wallet)</Text>
      {pending.map((event) => (
        <View key={String(event.id)} style={{ gap: 8 }}>
          <Text selectable>
            {event.method}({JSON.stringify(event.params)})
          </Text>
          <Button title="Approve" onPress={() => approve(event)} />
          <Button title="Reject" onPress={() => reject(event)} />
        </View>
      ))}
      <ScrollView style={{ flex: 1 }}>
        <Text selectable>{log}</Text>
      </ScrollView>
    </View>
  )
}
