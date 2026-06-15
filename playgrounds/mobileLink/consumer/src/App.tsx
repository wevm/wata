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

export default function App() {
  const [log, setLog] = React.useState('ready')

  React.useEffect(() => {
    const handle = (url: string) => {
      if (isMobileLinkCallback(url)) consumer.mobileLink.handleUrl(url)
    }
    const onUrl = Linking.addEventListener('url', ({ url }) => handle(url))
    void Linking.getInitialURL().then((url) => {
      if (url) handle(url)
    })
    const onError = consumer.onError((cause) => setLog(`error: ${cause.name}: ${cause.message}`))
    const onClose = consumer.onClose((cause) =>
      setLog(`closed${cause ? `: ${cause.message}` : ''}`),
    )
    return () => {
      onUrl.remove()
      onError.abort()
      onClose.abort()
    }
  }, [])

  function send(method: string, params: readonly unknown[]) {
    setLog(`sending ${method}, waiting for the wallet...`)
    // Supply the chosen host at start time. `start` is idempotent, so
    // calling it before every send is safe.
    consumer.mobileLink
      .start({ host: hostOrigin, scheme: hostScheme })
      .then(() => consumer.send({ method, params }))
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
