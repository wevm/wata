import * as React from 'react'
import { Button, ScrollView, Text, TextInput, View } from 'react-native'
import { Session, Wata, relay } from 'wata/host'
import { useSession } from 'wata/react'

// `allowPrivateNetwork` lets the host pair from a LAN pairing link
// (`relay=http://192.168.x.x:4860`) when scanning the dev consumer.
// Production relays are HTTPS and need no opt-in.
const wata = Wata.create({
  transports: [relay({ allowPrivateNetwork: true, receive: 'poll' })],
})

export default function App() {
  const [lines, setLines] = React.useState<readonly string[]>(['ready — paste a pairing uri'])
  const [pending, setPending] = React.useState<readonly Session.RequestEvent[]>([])
  const [uri, setUri] = React.useState('')

  const append = React.useCallback((line: string) => setLines((lines) => [...lines, line]), [])

  function settle(event: Session.RequestEvent) {
    setPending((queue) => queue.filter((queued) => queued !== event))
  }

  const { session, start, status } = useSession(wata, {
    onClose: (cause) => {
      append(cause ? `closed: ${cause.message}` : 'closed')
      setPending([])
    },
    onError: (error) => append(`error: ${error.message}`),
    onRequest: (event) => {
      append(`request: ${event.method} ${JSON.stringify(event.params)} — approve or deny`)
      setPending((queue) => [...queue, event])
    },
  })

  const connected = status === 'open'

  async function approve(event: Session.RequestEvent) {
    try {
      await event.respond({ message: 'pong from mobile' })
      append(`approved: ${event.method}`)
    } catch (error) {
      append(`error: ${(error as Error).message}`)
    } finally {
      settle(event)
    }
  }

  async function deny(event: Session.RequestEvent) {
    try {
      await event.reject({ code: 4001, message: 'User rejected the request' })
      append(`denied: ${event.method}`)
    } catch (error) {
      append(`error: ${(error as Error).message}`)
    } finally {
      settle(event)
    }
  }

  async function connect() {
    try {
      append('connecting…')
      await start({ uri: uri.trim() })
      append('connected')
    } catch (error) {
      append(`${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 72 }}>
      {connected ? (
        pending.length > 0 ? (
          <>
            {pending.map((event, index) => (
              <View key={`${index}-${event.method}`} style={{ gap: 4 }}>
                <Text>{`Approve ${event.method}?`}</Text>
                <Text selectable>{JSON.stringify(event.params)}</Text>
                <Button onPress={() => void approve(event)} title="Approve" />
                <Button color="#b00020" onPress={() => void deny(event)} title="Deny" />
              </View>
            ))}
          </>
        ) : (
          <>
            <Button
              onPress={() => {
                session
                  ?.notify({ method: 'accountsChanged', params: [['0xabc']] })
                  .then(() => append('notified accountsChanged'))
                  .catch((error: Error) => append(`error: ${error.message}`))
              }}
              title="Notify accountsChanged"
            />
            <Button onPress={() => void session?.close()} title="Disconnect" />
          </>
        )
      ) : (
        <>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={setUri}
            placeholder="urpc://?consumer_pubkey=…"
            style={{ borderWidth: 1, minHeight: 96, padding: 8 }}
            value={uri}
          />
          <Button disabled={!uri.trim()} onPress={() => void connect()} title="Connect" />
        </>
      )}
      <ScrollView style={{ flex: 1 }}>
        {lines.map((line, index) => (
          <Text key={`${index}-${line}`} selectable>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  )
}
