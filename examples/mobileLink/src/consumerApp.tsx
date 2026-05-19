import * as ExpoLinking from 'expo-linking'
import { useEffect, useState } from 'react'
import { Button, Linking, SafeAreaView, Text, View } from 'react-native'

import * as Constants from './constants'
import * as MobileLink from '../../../src/consumer/transports/mobileLink.js'
import * as Wata from '../../../src/Wata.js'

const wata = Wata.create({
  transports: [
    MobileLink.mobileLink({
      callbackUrl: ExpoLinking.createURL('/callback'),
      identity: { deepLinkUrl: Constants.hostUrl, publicKey: Constants.hostPublicKey },
      open: (url) => Linking.openURL(url),
    }),
  ],
})

export default function ConsumerApp() {
  const [result, setResult] = useState<{ accountName: string; message: string } | undefined>()
  const [status, setStatus] = useState('Not connected')

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('urpc=')) return
      setStatus('Finishing connection')
      wata.mobileLink.handle(url).catch(() => setStatus('Not connected'))
    })
    Linking.getInitialURL().then((url) => {
      if (!url?.includes('urpc=')) return
      setStatus('Finishing connection')
      wata.mobileLink.handle(url).catch(() => setStatus('Not connected'))
    })
    return () => subscription.remove()
  }, [])

  return (
    <SafeAreaView>
      <Button
        title="Connect Ironbank"
        onPress={() => {
          setResult(undefined)
          setStatus('Opening Ironbank')
          wata
            .send({
              method: 'authorizeAccountAccess',
              params: [{ appName: 'Spendlet', permissions: Constants.permissions }],
            })
            .then(({ result }) => {
              const value = result as { accountName: string; message: string }
              setResult(value)
              setStatus('Connected')
            })
            .catch(() => setStatus('Not connected'))
        }}
      />
      <Text>{status}</Text>
      {result ? (
        <View>
          <Text>{result.message}</Text>
          <Text>{result.accountName}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  )
}
