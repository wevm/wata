import * as ExpoLinking from 'expo-linking'
import { useEffect, useState } from 'react'
import { Button, Linking, ScrollView, StyleSheet, Text, View } from 'react-native'

import * as MobileLink from '../../../src/consumer/transports/mobileLink.js'
import * as Wata from '../../../src/Wata.js'
import { callbackPath, hostPublicKey, hostUrl } from './constants'
import { schema } from './schema'

const callbackUrl = ExpoLinking.createURL(callbackPath)
const permissions = ['Account balance', 'Recent transactions', 'Account holder name']

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
  const [connection, setConnection] = useState<
    'connected' | 'connecting' | 'idle' | 'not-connected'
  >('idle')
  const [response, setResponse] = useState<
    | {
        accountName: string
        message: string
        permissions: string[]
      }
    | undefined
  >()

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('urpc=')) return
      setConnection('connecting')
      wata.mobileLink.handle(url).catch(() => setConnection('not-connected'))
    })
    Linking.getInitialURL().then((url) => {
      if (!url) return
      if (!url.includes('urpc=')) return
      setConnection('connecting')
      wata.mobileLink.handle(url).catch(() => setConnection('not-connected'))
    })
    return () => subscription.remove()
  }, [])

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>Spendlet</Text>
      <Text style={styles.title}>Connect your bank</Text>
      <Text style={styles.copy}>
        Securely connect Ironbank to show your account balance and recent activity in Spendlet.
      </Text>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Spendlet will ask Ironbank for:</Text>
        {permissions.map((permission) => (
          <Text key={permission} style={styles.permission}>
            {permission}
          </Text>
        ))}
      </View>

      <Button
        disabled={connection === 'connecting'}
        title={connection === 'connecting' ? 'Opening Ironbank...' : 'Connect Ironbank'}
        onPress={() => {
          setConnection('connecting')
          setResponse(undefined)
          wata
            .send({
              method: 'authorizeAccountAccess',
              params: [{ appName: 'Spendlet', permissions }],
            })
            .then(({ result }) => {
              setResponse(result)
              setConnection('connected')
            })
            .catch(() => setConnection('not-connected'))
        }}
      />

      {connection === 'connected' && response ? (
        <View style={styles.successPanel}>
          <Text style={styles.successTitle}>Connected to Ironbank</Text>
          <Text style={styles.copy}>{response.message}</Text>
          <Text style={styles.detail}>Account: {response.accountName}</Text>
        </View>
      ) : null}

      {connection === 'not-connected' ? (
        <View style={styles.noticePanel}>
          <Text style={styles.panelTitle}>Ironbank was not connected</Text>
          <Text style={styles.copy}>You can try again whenever you are ready.</Text>
        </View>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  copy: {
    color: '#4b5563',
    fontSize: 16,
    lineHeight: 24,
  },
  detail: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '600',
  },
  eyebrow: {
    color: '#0f766e',
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  noticePanel: {
    backgroundColor: '#f8fafc',
    borderColor: '#d1d5db',
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  panel: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    gap: 8,
    padding: 14,
  },
  panelTitle: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '700',
  },
  permission: {
    color: '#374151',
    fontSize: 15,
    lineHeight: 22,
  },
  screen: {
    flexGrow: 1,
    gap: 16,
    padding: 24,
    paddingTop: 72,
  },
  successPanel: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  successTitle: {
    color: '#065f46',
    fontSize: 17,
    fontWeight: '700',
  },
  title: {
    color: '#111827',
    fontSize: 28,
    fontWeight: '800',
  },
})
