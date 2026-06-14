/**
 * Consumer for the relay playground — plays the "web app".
 *
 * Sending the first request lazily starts the relay transport: the
 * consumer slot is locked and the pairing uri is printed. Copy the
 * `pnpm dev:host '<uri>'` line into another terminal to connect the
 * host. Once the host connects and the encrypted session keys, the
 * buffered request flushes and the result prints; inbound notifications
 * the host pushes keep printing until you Ctrl-C.
 *
 * Set `RECEIVE=poll` to receive over short polling (instant `wait=0`
 * GETs every ~2s, spec §5.3) instead of the default SSE; `RELAY_URL`
 * overrides the relay address.
 */

import { Wata, relay } from 'wata'

const receive = process.env.RECEIVE ?? 'sse'
const url = process.env.RELAY_URL ?? 'http://localhost:4860'

const wata = Wata.create({
  transports: [relay({ receive, url })],
})

wata.on('prompt', ({ uri }) => {
  console.log('pair the host with:')
  console.log(`  pnpm dev:host '${uri}'`)
})
wata.on('notification', (event) =>
  console.log(`notification: ${event.method} ${JSON.stringify(event.params)}`),
)
wata.on('close', (cause) => console.log(cause ? `closed: ${cause.message}` : 'closed'))
wata.on('error', (error) => console.log(`error: ${error.message}`))

console.log(`consumer receiving over '${receive}' — sending ping…`)
try {
  const { result } = await wata.send({ method: 'ping', params: [{ from: 'consumer' }] })
  console.log(`result: ${JSON.stringify(result)}`)
} catch (error) {
  // The host can deny the request — surface the rejection instead of crashing.
  console.log(`rejected: ${(error as Error).message}`)
}
console.log('session open — waiting for notifications (Ctrl-C to quit)')
