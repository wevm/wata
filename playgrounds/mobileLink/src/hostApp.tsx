import { useEffect, useState } from 'react'
import { Button, Linking, ScrollView, StyleSheet, Text, View } from 'react-native'

import * as HostMobileLink from '../../../src/host/transports/mobileLink.js'
import * as HostWata from '../../../src/host/Wata.js'
import { hostPath, hostPrivateKey, hostScheme, hostUrl } from './constants'
import { schema } from './schema'

type AccessRequest = {
  appName: string
  permissions: string[]
}

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
  const [decision, setDecision] = useState<'approved' | 'denied' | undefined>()
  const [pending, setPending] = useState<HostWata.SchemaRequestEvent<typeof schema> | undefined>()
  const [request, setRequest] = useState<AccessRequest | undefined>()
  const [status, setStatus] = useState('Ready for Spendlet')

  useEffect(() => {
    const requests = wata.on('request', (event) => {
      if (event.method === 'authorizeAccountAccess') {
        setDecision(undefined)
        setPending(event)
        setRequest(event.params[0])
        setStatus('Review this request')
      }
      return undefined
    })
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('urpc=')) return
      setStatus('Opening request...')
      wata.mobileLink.handle(url).catch(() => setStatus('Unable to open request'))
    })
    Linking.getInitialURL().then((url) => {
      if (!url) return
      if (!url.includes('urpc=')) return
      setStatus('Opening request...')
      wata.mobileLink.handle(url).catch(() => setStatus('Unable to open request'))
    })
    return () => {
      requests.abort()
      subscription.remove()
    }
  }, [])

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>Ironbank</Text>
      <Text style={styles.title}>
        {request ? `Allow ${request.appName} to access your account?` : 'Waiting for Spendlet'}
      </Text>
      <Text style={styles.copy}>
        {request
          ? `${request.appName} is asking to view your Ironbank account information.`
          : 'Open Spendlet and choose Connect Ironbank to start.'}
      </Text>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>
          {request ? `${request.appName} will be able to view:` : 'No request yet'}
        </Text>
        {request ? (
          request.permissions.map((permission) => (
            <Text key={permission} style={styles.permission}>
              {permission}
            </Text>
          ))
        ) : (
          <Text style={styles.copy}>You are in control of what gets shared.</Text>
        )}
      </View>

      {request ? (
        <View style={styles.actions}>
          <Button
            disabled={!pending}
            title="Allow access"
            onPress={() => {
              if (!pending || !request) return
              const event = pending
              setPending(undefined)
              setDecision('approved')
              setStatus('Access approved')
              event
                .respond({
                  accountName: 'Ironbank Everyday',
                  approved: true,
                  at: new Date().toISOString(),
                  message: `${request.appName} can now view your Ironbank account.`,
                  permissions: request.permissions,
                })
                .catch(() => setStatus('Unable to send approval'))
            }}
          />
          <Button
            color="#6b7280"
            disabled={!pending}
            title="Deny"
            onPress={() => {
              if (!pending) return
              const event = pending
              setPending(undefined)
              setDecision('denied')
              setStatus('Access denied')
              event
                .reject({ code: -32000, message: 'Access denied' })
                .catch(() => setStatus('Unable to send denial'))
            }}
          />
        </View>
      ) : null}

      {decision === 'approved' ? (
        <View style={styles.successPanel}>
          <Text style={styles.successTitle}>Access approved</Text>
          <Text style={styles.copy}>You can return to Spendlet to continue.</Text>
        </View>
      ) : null}

      {decision === 'denied' ? (
        <View style={styles.noticePanel}>
          <Text style={styles.panelTitle}>Access denied</Text>
          <Text style={styles.copy}>Spendlet will not be able to view your Ironbank account.</Text>
        </View>
      ) : null}

      <Text style={styles.status}>{status}</Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  actions: {
    gap: 8,
  },
  copy: {
    color: '#4b5563',
    fontSize: 16,
    lineHeight: 24,
  },
  eyebrow: {
    color: '#1d4ed8',
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
  status: {
    color: '#6b7280',
    fontSize: 13,
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
