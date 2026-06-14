import * as React from 'react'
import { Button, ScrollView, Text, TextInput, View } from 'react-native'
import { Wata, relay } from 'wata/host'

const wata = Wata.create({ transports: [relay({ receive: 'poll' })] })

export default function App() {
  const [lines, setLines] = React.useState<readonly string[]>(['ready — paste a pairing uri'])
  const [connected, setConnected] = React.useState(false)
  const [pending, setPending] = React.useState<readonly Wata.RequestEvent[]>([])
  const [uri, setUri] = React.useState('')

  const append = React.useCallback((line: string) => setLines((lines) => [...lines, line]), [])

  // Register the hoisted session's listeners once.
  React.useEffect(() => {
    const subscriptions = [
      wata.on('request', (event) => {
        append(`request: ${event.method} ${JSON.stringify(event.params)} — approve or deny`)
        setPending((queue) => [...queue, event])
      }),
      wata.on('close', (cause) => {
        append(cause ? `closed: ${cause.message}` : 'closed')
        setConnected(false)
        setPending([])
      }),
      wata.on('error', (error) => append(`error: ${error.message}`)),
    ]
    return () => subscriptions.forEach((subscription) => subscription.abort())
  }, [append])

  function settle(event: Wata.RequestEvent) {
    setPending((queue) => queue.filter((queued) => queued !== event))
  }

  async function approve(event: Wata.RequestEvent) {
    try {
      await event.respond({ message: 'pong from mobile' })
      append(`approved: ${event.method}`)
    } catch (error) {
      append(`error: ${(error as Error).message}`)
    } finally {
      settle(event)
    }
  }

  async function deny(event: Wata.RequestEvent) {
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
      await wata.relay.start({ pairingUri: uri.trim() })
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
                wata
                  .notify({ method: 'accountsChanged', params: [['0xabc']] })
                  .then(() => append('notified accountsChanged'))
                  .catch((error: Error) => append(`error: ${error.message}`))
              }}
              title="Notify accountsChanged"
            />
            <Button onPress={() => void wata.close()} title="Disconnect" />
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
