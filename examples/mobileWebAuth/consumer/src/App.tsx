import * as WebBrowser from 'expo-web-browser'
import * as React from 'react'
import { Button, Text, View } from 'react-native'
import { Wata, mobileWebAuth } from 'wata'

const wata = Wata.create({
  transports: [
    mobileWebAuth({
      callback: 'com.example.mobilewebauth://callback',
      host: process.env.EXPO_PUBLIC_HOST_URL ?? 'http://localhost:5611',
      id: 'https://app.example',
      openAuthSession: async ({ authorizationUrl, callback }) => {
        const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, callback)
        return result.type === 'success' ? result.url : undefined
      },
    }),
  ],
})

export default function App() {
  const [log, setLog] = React.useState('Ready — connect to the Example Wallet.')

  return (
    <View style={{ gap: 12, padding: 24, paddingTop: 72 }}>
      <Button
        title="Connect wallet"
        onPress={() => {
          setLog('Waiting for approval…')
          wata
            .start()
            .then((session) => session.send({ method: 'eth_requestAccounts', params: [] }))
            .then((response) => setLog(`Connected: ${JSON.stringify(response.result)}`))
            .catch((cause: Error) => setLog(`${cause.name}: ${cause.message}`))
        }}
      />
      <Text selectable>{log}</Text>
    </View>
  )
}
