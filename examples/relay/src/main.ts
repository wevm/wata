import { Wata, relay } from 'wata'
import { Wata as HostWata, relay as hostRelay } from 'wata/host'
import { relayServer } from 'wata/server'

const log = document.getElementById('log') as HTMLPreElement
const send = document.getElementById('send') as HTMLButtonElement

const server = relayServer({ responseTimeout: 25 })
const relayUrl = 'https://relay.example/r'
const fetchRelay = (input: RequestInfo | URL, init?: RequestInit) =>
  server.fetch(new Request(input, init))

const consumer = Wata.create({
  transports: [
    relay({
      fetch: fetchRelay,
      pairingSecret: 'secret',
      sessionId: 'demo',
      url: relayUrl,
    }),
  ],
})

const host = HostWata.create({
  transports: [
    hostRelay({
      fetch: fetchRelay,
      pairingSecret: 'secret',
      sessionId: 'demo',
      url: relayUrl,
    }),
  ],
})

host.on('request', async (event) => {
  if (event.method === 'ping')
    await event.respond({ message: 'pong from host', transport: event.transport })
  else await event.reject({ code: -32601, message: 'method not found' })
})

send.addEventListener('click', async () => {
  try {
    const { result } = await consumer.send({ method: 'ping', params: [] })
    log.textContent = JSON.stringify(result, null, 2)
  } catch (error) {
    log.textContent = (error as Error).message
  }
})
