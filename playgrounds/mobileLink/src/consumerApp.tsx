import * as ExpoLinking from 'expo-linking'
import { useEffect, useState } from 'react'
import { Button, Linking, ScrollView, Text, View } from 'react-native'

import * as MobileLink from '../../../src/consumer/transports/mobileLink.js'
import * as Wata from '../../../src/Wata.js'
import { callbackPath, hostPublicKey, hostUrl } from './constants'
import { schema } from './schema'

const callbackUrl = ExpoLinking.createURL(callbackPath)

const wata = Wata.create({
  schema,
  transports: [
    MobileLink.mobileLink({
      callbackUrl,
      identity: { deepLinkUrl: hostUrl, publicKey: hostPublicKey },
      open: (url) => Linking.openURL(url),
    }),
  ],
})

export default function ConsumerApp() {
  const [log, setLog] = useState(`consumer callback: ${callbackUrl}\nhost app: ${hostUrl}`)

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      setLog((value) => `${value}\nconsumer received ${url}`)
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
    })
    Linking.getInitialURL().then((url) => {
      if (!url) return
      setLog((value) => `${value}\nconsumer initial ${url}`)
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
    })
    return () => subscription.remove()
  }, [])

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 64 }}>
      <Text>Consumer app</Text>
      <Button
        title="Ping wallet"
        onPress={() => {
          setLog(`consumer callback: ${callbackUrl}\nhost app: ${hostUrl}\nwaiting...`)
          wata
            .send({ method: 'ping', params: [] })
            .then(({ result }) => setLog((value) => `${value}\n${JSON.stringify(result, null, 2)}`))
            .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
        }}
      />
      <ScrollView>
        <Text selectable>{log}</Text>
      </ScrollView>
    </View>
  )
}
