import * as ExpoLinking from 'expo-linking'
import { useEffect, useState } from 'react'
import { Button, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

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
  const [message, setMessage] = useState('ping')
  const [response, setResponse] = useState<
    { at: string; message: string; transport: string } | undefined
  >()
  const [status, setStatus] = useState('Ready')

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('urpc=')) return
      setStatus('Receiving wallet response...')
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setStatus(error.message))
    })
    Linking.getInitialURL().then((url) => {
      if (!url) return
      if (!url.includes('urpc=')) return
      setStatus('Receiving wallet response...')
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setStatus(error.message))
    })
    return () => subscription.remove()
  }, [])

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Consumer app</Text>
      <Text style={styles.label}>Request payload</Text>
      <TextInput
        autoCapitalize="none"
        onChangeText={setMessage}
        style={styles.input}
        value={message}
      />
      <Button
        title="Send"
        onPress={() => {
          setResponse(undefined)
          setStatus('Opening wallet...')
          wata
            .send({ method: 'ping', params: [message] })
            .then(({ result }) => {
              setResponse(result)
              setStatus('Done')
            })
            .catch((error: Error) => setStatus(error.message))
        }}
      />
      <ScrollView contentContainerStyle={styles.stack}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Received</Text>
          <Text selectable style={styles.payload}>
            {response
              ? `message: ${response.message}\ntransport: ${response.transport}\nat: ${response.at}`
              : 'No response yet'}
          </Text>
        </View>
        <Text selectable style={styles.meta}>
          {`status: ${status}\ncallback: ${callbackUrl}\nhost: ${hostUrl}`}
        </Text>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  input: {
    borderColor: '#c8c8c8',
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: {
    color: '#555',
    fontSize: 13,
    fontWeight: '600',
  },
  meta: {
    color: '#666',
    fontSize: 12,
    lineHeight: 18,
  },
  panel: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    gap: 6,
    padding: 12,
  },
  panelTitle: {
    color: '#333',
    fontSize: 13,
    fontWeight: '700',
  },
  payload: {
    fontFamily: 'Menlo',
    fontSize: 13,
    lineHeight: 20,
  },
  screen: {
    flex: 1,
    gap: 12,
    padding: 24,
    paddingTop: 64,
  },
  stack: {
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
})
