import { useEffect, useState } from 'react'
import { Linking, ScrollView, Text, View } from 'react-native'

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

  useEffect(() => {
    const requests = wata.on('request', (event) => {
      setLog((value) => `${value}\nwallet received ${event.method}`)
      if (event.method === 'ping')
        return { at: new Date().toISOString(), ok: true, transport: event.transport }
      return undefined
    })
    const subscription = Linking.addEventListener('url', ({ url }) => {
      setLog((value) => `${value}\nwallet link ${url}`)
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
    })
    Linking.getInitialURL().then((url) => {
      if (!url) return
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
      <ScrollView>
        <Text selectable>{log}</Text>
      </ScrollView>
    </View>
  )
}
