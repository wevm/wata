import { Wata, relay } from 'wata'

const host = import.meta.env['VITE_HOST_URL'] ?? 'http://localhost:4777'
const log = document.getElementById('log') as HTMLPreElement
const send = document.getElementById('send') as HTMLButtonElement

const consumer = Wata.create({
  transports: [
    relay({
      host,
      pairingSecret: import.meta.env['VITE_RELAY_PAIRING_SECRET'] ?? 'secret',
      sessionId: import.meta.env['VITE_RELAY_SESSION_ID'] ?? 'demo',
    }),
  ],
})

send.addEventListener('click', async () => {
  send.disabled = true
  log.textContent = 'waiting...'
  try {
    const { result } = await consumer.send({ method: 'ping', params: [] })
    log.textContent = JSON.stringify(result, null, 2)
  } catch (error) {
    log.textContent = (error as Error).message
  } finally {
    send.disabled = false
  }
})
