import { useEffect, useState } from 'react'
import { Button, Linking, ScrollView, Text, View } from 'react-native'

import * as HostMobileLink from '../../../src/host/transports/mobileLink.js'
import * as HostWata from '../../../src/host/Wata.js'
import { hostPath, hostPrivateKey, hostScheme, hostUrl } from './constants'
import { schema } from './schema'

const wata = HostWata.create({
  privateKey: hostPrivateKey,
  schema,
  transports: [
    HostMobileLink.mobileLink({
      open: (url) => Linking.openURL(url),
      path: hostPath,
      scheme: hostScheme,
      universalLink: hostUrl,
    }),
  ],
})

export default function HostApp() {
  const [log, setLog] = useState(`wallet link: ${hostUrl}`)
  const [pending, setPending] = useState<HostWata.SchemaRequestEvent<typeof schema> | undefined>()

  useEffect(() => {
    const requests = wata.on('request', (event) => {
      setLog((value) => `${value}\nwallet received ${event.method}\nwaiting for approval`)
      if (event.method === 'ping') setPending(event)
      return undefined
    })
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('urpc=')) return
      setLog((value) => `${value}\nwallet link ${url}`)
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
    })
    Linking.getInitialURL().then((url) => {
      if (!url) return
      if (!url.includes('urpc=')) return
      setLog((value) => `${value}\nwallet initial ${url}`)
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
    })
    return () => {
      requests.abort()
      subscription.remove()
    }
  }, [])

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 64 }}>
      <Text>Wallet app</Text>
      {pending ? (
        <Button
          title="Respond to ping"
          onPress={() => {
            const event = pending
            setPending(undefined)
            event
              .respond({ at: new Date().toISOString(), ok: true, transport: event.transport })
              .then(() => setLog((value) => `${value}\nwallet responded ${event.method}`))
              .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
          }}
        />
      ) : null}
      <ScrollView>
        <Text selectable>{log}</Text>
      </ScrollView>
    </View>
  )
}
