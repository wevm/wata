import * as React from 'react'
import { Button, Linking, Text, View } from 'react-native'
import { Wata, mobileWebAuth } from 'wata'

const callbackUrl = 'mobilewebauth://callback'
const consumerId = process.env.EXPO_PUBLIC_CONSUMER_ID ?? 'http://localhost:19006'
const hostOrigin = process.env.EXPO_PUBLIC_HOST_ORIGIN ?? 'http://localhost:4780'

export default function App() {
  const [log, setLog] = React.useState('ready')
  const consumer = React.useMemo(
    () =>
      Wata.create({
        baseUrl: consumerId,
        meta: { name: 'Expo Consumer' },
        transports: [
          mobileWebAuth({
            callbackUrl,
            host: hostOrigin,
            open: (url) => Linking.openURL(url),
          }),
        ],
      }),
    [],
  )

  React.useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      void consumer.mobileWebAuth.handle(url).catch((cause: Error) => {
        setLog(`${cause.name}: ${cause.message}`)
      })
    })
    void Linking.getInitialURL().then((url) => {
      if (url)
        void consumer.mobileWebAuth.handle(url).catch((cause: Error) => {
          setLog(`${cause.name}: ${cause.message}`)
        })
    })
    return () => subscription.remove()
  }, [consumer])

  return (
    <View style={{ gap: 12, padding: 24, paddingTop: 72 }}>
      <Button
        title="Send ping"
        onPress={() => {
          setLog('waiting for approval...')
          void consumer.mobileWebAuth
            .send({ method: 'ping', params: [] })
            .then((response) => setLog(JSON.stringify(response.result, undefined, 2)))
            .catch((cause: Error) => setLog(`${cause.name}: ${cause.message}`))
        }}
      />
      <Text selectable>{log}</Text>
    </View>
  )
}
