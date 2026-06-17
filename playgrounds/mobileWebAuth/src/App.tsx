import * as WebBrowser from 'expo-web-browser'
import * as React from 'react'
import { Button, Text, View } from 'react-native'
import { Wata, mobileWebAuth } from 'wata'

const callback = 'mobilewebauth://callback'
const consumerOrigin = process.env.EXPO_PUBLIC_CONSUMER_ID ?? 'http://localhost:19006'
const hostOrigin = process.env.EXPO_PUBLIC_HOST_ORIGIN ?? 'http://localhost:4780'

export default function App() {
  const [log, setLog] = React.useState('ready')
  const consumer = React.useMemo(
    () =>
      Wata.create({
        baseUrl: consumerOrigin,
        meta: { name: 'Expo Consumer' },
        transports: [
          mobileWebAuth({
            callback,
            host: hostOrigin,
            openAuthSession: async ({ authorizationUrl, callback }) => {
              const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, callback)
              if (result.type === 'success') return result.url
              return undefined
            },
          }),
        ],
      }),
    [],
  )

  return (
    <View style={{ gap: 12, padding: 24, paddingTop: 72 }}>
      <Button
        title="Send ping"
        onPress={() => {
          setLog('waiting for approval...')
          void consumer
            .start()
            .then((session) =>
              session.send({
                method: 'ping',
                params: [],
              }),
            )
            .then((response) => setLog(JSON.stringify(response.result, undefined, 2)))
            .catch((cause: Error) => setLog(`${cause.name}: ${cause.message}`))
        }}
      />
      <Text selectable>{log}</Text>
    </View>
  )
}
