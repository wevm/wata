import * as ExpoLinking from 'expo-linking'
import { useEffect, useState } from 'react'
import { Button, Linking, ScrollView, Text, View } from 'react-native'
import { Wata, mobileLink } from 'wata'

const callbackUrl = ExpoLinking.createURL('/callback')
const hostUrl = process.env.EXPO_PUBLIC_HOST_URL ?? 'http://localhost:4748/auth/mobile-link'
const publicKey =
  process.env.EXPO_PUBLIC_HOST_PUBLIC_KEY ?? 'oJql9HpnWYAv-VX43C0qFKXJnSO-l_hkEn_5ODRVpPA'

const wata = Wata.create({
  transports: [
    mobileLink({
      callbackUrl,
      identity: { deepLinkUrl: hostUrl, publicKey },
      open: (url) => Linking.openURL(url),
    }),
  ],
})

export default function App() {
  const [log, setLog] = useState(`callback: ${callbackUrl}\nhost: ${hostUrl}`)

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      setLog((value) => `${value}\ncallback ${url}`)
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
    })
    Linking.getInitialURL().then((url) => {
      if (url)
        wata.mobileLink
          .handle(url)
          .catch((error: Error) => setLog((value) => `${value}\n${error.message}`))
    })
    return () => subscription.remove()
  }, [])

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 64 }}>
      <Button
        title="Ping"
        onPress={() => {
          setLog(`callback: ${callbackUrl}\nhost: ${hostUrl}\nwaiting...`)
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
