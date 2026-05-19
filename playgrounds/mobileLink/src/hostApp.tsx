import { useEffect, useState } from 'react'
import { Button, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

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
  const [message, setMessage] = useState('pong')
  const [pending, setPending] = useState<HostWata.SchemaRequestEvent<typeof schema> | undefined>()
  const [request, setRequest] = useState<
    { message: string; method: string; transport: string } | undefined
  >()
  const [status, setStatus] = useState('Waiting for request')

  useEffect(() => {
    const requests = wata.on('request', (event) => {
      setStatus('Ready to respond')
      if (event.method === 'ping') {
        setMessage('pong')
        setPending(event)
        setRequest({
          message: event.params[0],
          method: event.method,
          transport: event.transport,
        })
      }
      return undefined
    })
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('urpc=')) return
      setStatus('Opening request...')
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setStatus(error.message))
    })
    Linking.getInitialURL().then((url) => {
      if (!url) return
      if (!url.includes('urpc=')) return
      setStatus('Opening request...')
      wata.mobileLink
        .handle(url)
        .catch((error: Error) => setStatus(error.message))
    })
    return () => {
      requests.abort()
      subscription.remove()
    }
  }, [])

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Wallet app</Text>
      <Text style={styles.label}>Response payload</Text>
      <TextInput
        autoCapitalize="none"
        onChangeText={setMessage}
        style={styles.input}
        value={message}
      />
      <Button
        disabled={!pending}
        title="Send"
        onPress={() => {
          if (!pending) return
          const event = pending
          const value = message
          setPending(undefined)
          setStatus('Sending response...')
          event
            .respond({ at: new Date().toISOString(), message: value, transport: event.transport })
            .then(() => setStatus('Done'))
            .catch((error: Error) => setStatus(error.message))
        }}
      />
      <ScrollView contentContainerStyle={styles.stack}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Received</Text>
          <Text selectable style={styles.payload}>
            {request
              ? `method: ${request.method}\nmessage: ${request.message}\ntransport: ${request.transport}`
            : 'No request yet'}
          </Text>
        </View>
        <Text selectable style={styles.meta}>
          {`status: ${status}\nwallet: ${hostUrl}`}
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
