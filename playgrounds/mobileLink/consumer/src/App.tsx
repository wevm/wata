import * as Linking from 'expo-linking'
import * as React from 'react'
import { Button, ScrollView, Text, View } from 'react-native'
import { Wata, mobileLink } from 'wata'

import { consumerOrigin, consumerReturnUrl, hostOrigin, hostScheme } from './config.js'

/** A mobile-link callback always carries `message` + `version` query params. */
function isMobileLinkCallback(url: string): boolean {
  try {
    const { searchParams } = new URL(url)
    return searchParams.has('message') && searchParams.has('version')
  } catch {
    return false
  }
}

const consumer = Wata.create({
  baseUrl: consumerOrigin,
  meta: { name: 'Wata App' },
  transports: [
    mobileLink({
      async openLink(url) {
        await Linking.openURL(url)
      },
      returnUrl: consumerReturnUrl,
    }),
  ],
})

type Session = Awaited<ReturnType<typeof consumer.mobileLink.start>>

export default function App() {
  const [log, setLog] = React.useState('ready')
  const sessionRef = React.useRef<Session | undefined>(undefined)

  function start() {
    if (!sessionRef.current) {
      const session = consumer.mobileLink.start({ host: hostOrigin, target: hostScheme })
      sessionRef.current = session
      session.onClose((cause) => setLog(`closed${cause ? `: ${cause.message}` : ''}`))
      session.onError((cause) => setLog(`error: ${cause.name}: ${cause.message}`))
    }
    return sessionRef.current
  }

  React.useEffect(() => {
    const handle = (url: string) => {
      if (isMobileLinkCallback(url)) void sessionRef.current?.handleUrl(url)
    }
    const onUrl = Linking.addEventListener('url', ({ url }) => handle(url))
    void Linking.getInitialURL().then((url) => {
      if (url) handle(url)
    })
    return () => {
      onUrl.remove()
    }
  }, [])

  function send(method: string, params: readonly unknown[]) {
    setLog(`sending ${method}, waiting for the wallet...`)
    start()
      .send({ method, params })
      .then((response) => setLog(JSON.stringify(response.result, undefined, 2)))
      .catch((cause: Error) => setLog(`${cause.name}: ${cause.message}`))
  }

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 72 }}>
      <Text style={{ fontSize: 20, fontWeight: '600' }}>mobileLink consumer</Text>
      <Button title="Send ping" onPress={() => send('ping', [])} />
      <Button title="Send echo" onPress={() => send('echo', ['hello'])} />
      <Button title="Clear log" onPress={() => setLog('ready')} />
      <ScrollView style={{ flex: 1 }}>
        <Text selectable>{log}</Text>
      </ScrollView>
    </View>
  )
}
