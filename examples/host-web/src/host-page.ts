/**
 * Browser host page for the `postMessage` transport (used by `consumer-web`).
 *
 * `consumer-web` opens this page in a popup at
 * `/host.html?origin=<consumer-origin>`; the host pins that origin, answers
 * the request, then closes the popup. The SDK re-opens it on the next send.
 */

import { host } from './host.js'

const status = document.getElementById('status') as HTMLElement

const session = await host.postMessage.start()
status.textContent = 'ready'

session.onError((error) => {
  status.textContent = error.message
})

session.onRequest(async (event) => {
  status.textContent = `request: ${event.method}`
  if (event.method === 'eth_requestAccounts' || event.method === 'wallet_connect')
    await event.respond(['0x0000000000000000000000000000000000000001'])
  else await event.respond({ message: 'pong from web host', transport: event.transport })
  // Popup host: close after answering. The consumer re-opens on next send.
  window.close()
})
