import * as WebBrowser from 'expo-web-browser'
import * as React from 'react'
import { Button, Text, View } from 'react-native'

import { hostOrigin } from './config.js'
import { wata } from './wata.js'

export default function App() {
  const [log, setLog] = React.useState('Ready — connect to the Example Wallet.')

  return (
    <View style={{ gap: 12, padding: 24, paddingTop: 72 }}>
      <Button
        title="Connect wallet"
        onPress={() => {
          setLog('Waiting for approval…')
          wata
            .start({
              host: hostOrigin,
              openAuthSession: async ({ authorizationUrl, callback }) => {
                const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, callback)
                return result.type === 'success' ? result.url : undefined
              },
            })
            .then((session) => session.send({ method: 'eth_requestAccounts', params: [] }))
            .then((response) => setLog(`Connected: ${JSON.stringify(response.result)}`))
            .catch((cause: Error) => setLog(`${cause.name}: ${cause.message}`))
        }}
      />
      <Text selectable>{log}</Text>
    </View>
  )
}
