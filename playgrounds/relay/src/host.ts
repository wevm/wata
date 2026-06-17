/**
 * Host for the relay playground — plays the "mobile wallet".
 *
 * Takes the pairing uri printed by the consumer as its first argument
 * (the relay address is embedded in the uri), connects, then — like a
 * real wallet — prompts you to **approve** or **deny** each inbound
 * request before answering. Approve sends an encrypted `pong`; deny
 * rejects with a `4001` user-rejected error. After connecting it pushes
 * one `accountsChanged` notification back to the consumer to show the
 * reverse direction, then stays open until Ctrl-C.
 *
 * Set `RECEIVE=poll` to receive over short polling (instant `wait=0`
 * GETs every ~2s, spec §5.3) instead of the default SSE.
 */

import { createInterface } from 'node:readline/promises'
import { Wata, relay } from 'wata/host'

const uri = process.argv[2]
if (!uri) {
  console.error("usage: pnpm dev:host '<pairing-uri>'")
  process.exit(1)
}

const receive = process.env.RECEIVE ?? 'sse'

const rl = createInterface({ input: process.stdin, output: process.stdout })

const session = await Wata.create({ transports: [relay({ uri: uri, receive })] }).start()

session.onRequest(async (event) => {
  console.log(`request: ${event.method} ${JSON.stringify(event.params)}`)
  const answer = (await rl.question('approve? (y/n) ')).trim().toLowerCase()
  if (answer === 'y' || answer === 'yes') {
    await event.respond({ message: 'pong from host' })
    console.log('approved')
  } else {
    await event.reject({ code: 4001, message: 'User rejected the request' })
    console.log('denied')
  }
})
session.onClose((cause) => console.log(cause ? `closed: ${cause.message}` : 'closed'))
session.onError((error) => console.log(`error: ${error.message}`))

console.log('connected — approve/deny inbound requests (Ctrl-C to quit)')

await session.notify({ method: 'accountsChanged', params: [['0xabc']] })
console.log('pushed accountsChanged notification')
