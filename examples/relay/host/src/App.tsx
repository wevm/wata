import * as React from 'react'
import { Button, ScrollView, Text, TextInput, View } from 'react-native'
import { Session, Wata, relay } from 'wata/host'

// `allowPrivateNetwork` lets the host pair from a LAN pairing link
// (`relay=http://192.168.x.x:4860`) when scanning the dev consumer.
// Production relays are HTTPS and need no opt-in.
const wata = Wata.create({
  transports: [relay({ allowPrivateNetwork: true, receive: 'poll' })],
})

export default function App() {
  const [lines, setLines] = React.useState<readonly string[]>(['ready — paste a pairing uri'])
  const [connected, setConnected] = React.useState(false)
  const [pending, setPending] = React.useState<readonly Session.RequestEvent[]>([])
  const [uri, setUri] = React.useState('')
  const session = React.useRef<Awaited<ReturnType<typeof wata.relay.start>> | undefined>(undefined)

  const append = React.useCallback((line: string) => setLines((lines) => [...lines, line]), [])

  React.useEffect(
    () => () => {
      void session.current?.close()
    },
    [],
  )

  function settle(event: Session.RequestEvent) {
    setPending((queue) => queue.filter((queued) => queued !== event))
  }

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
      const next = await wata.relay.start({ uri: uri.trim() })
      session.current = next
      const subscriptions = [
        next.onRequest((event) => {
          append(`request: ${event.method} ${JSON.stringify(event.params)} — approve or deny`)
          setPending((queue) => [...queue, event])
        }),
        next.onClose((cause) => {
          append(cause ? `closed: ${cause.message}` : 'closed')
          session.current = undefined
          setConnected(false)
          setPending([])
        }),
        next.onError((error) => append(`error: ${error.message}`)),
      ]
      next.onClose(() => subscriptions.forEach((subscription) => subscription.abort()))
      append('connected')
      setConnected(true)
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
                const current = session.current
                if (!current) return
                current
                  .notify({ method: 'accountsChanged', params: [['0xabc']] })
                  .then(() => append('notified accountsChanged'))
                  .catch((error: Error) => append(`error: ${error.message}`))
              }}
              title="Notify accountsChanged"
            />
            <Button onPress={() => void session.current?.close()} title="Disconnect" />
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
