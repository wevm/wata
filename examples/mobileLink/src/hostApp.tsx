import { useEffect, useState } from 'react'
import { Button, Linking, SafeAreaView, Text } from 'react-native'

import * as Constants from './constants'
import * as HostMobileLink from '../../../src/host/transports/mobileLink.js'
import * as HostWata from '../../../src/host/Wata.js'

type AccessRequest = {
  appName: string
  permissions: string[]
}

const wata = HostWata.create({
  privateKey: Constants.hostPrivateKey,
  transports: [
    HostMobileLink.mobileLink({
      open: (url) => Linking.openURL(url),
      path: Constants.hostPath,
      scheme: Constants.hostScheme,
      universalLink: Constants.hostUrl,
    }),
  ],
})

export default function HostApp() {
  const [pending, setPending] = useState<HostWata.SchemaRequestEvent<undefined> | undefined>()
  const [request, setRequest] = useState<AccessRequest | undefined>()
  const [status, setStatus] = useState('Waiting for Spendlet')

  useEffect(() => {
    const requests = wata.on('request', (event) => {
      if (event.method !== 'authorizeAccountAccess') return undefined
      const params = Array.isArray(event.params) ? event.params : []
      const request = params[0] as AccessRequest | undefined
      if (!request) return undefined
      setPending(event)
      setRequest(request)
      setStatus('Review request')
      return undefined
    })
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('urpc=')) return
      setStatus('Opening request')
      wata.mobileLink.handle(url).catch(() => setStatus('Waiting for Spendlet'))
    })
    Linking.getInitialURL().then((url) => {
      if (!url?.includes('urpc=')) return
      setStatus('Opening request')
      wata.mobileLink.handle(url).catch(() => setStatus('Waiting for Spendlet'))
    })
    return () => {
      requests.abort()
      subscription.remove()
    }
  }, [])

  return (
    <SafeAreaView>
      <Button
        disabled={!pending}
        title="Allow access"
        onPress={() => {
          if (!pending || !request) return
          const event = pending
          setPending(undefined)
          setRequest(undefined)
          setStatus('Access approved')
          event
            .respond({
              accountName: 'Ironbank Everyday',
              approved: true,
              at: new Date().toISOString(),
              message: `${request.appName} can now view your Ironbank account.`,
              permissions: request.permissions,
            })
            .catch(() => setStatus('Waiting for Spendlet'))
        }}
      />
      <Button
        disabled={!pending}
        title="Not now"
        onPress={() => {
          if (!pending) return
          const event = pending
          setPending(undefined)
          setRequest(undefined)
          setStatus('Not connected')
          event.reject({ code: -32000, message: 'Access denied' }).catch(() => {
            setStatus('Waiting for Spendlet')
          })
        }}
      />
      <Text>{status}</Text>
    </SafeAreaView>
  )
}
