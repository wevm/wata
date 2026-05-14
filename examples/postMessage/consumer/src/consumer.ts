/**
 * Minimal consumer-side example for the `postMessage` transport.
 *
 * Opens the host in a popup (cross-origin), opens a `Handshake` session
 * over `postMessage`, and sends a `ping` request when the button is
 * clicked. The host closes its popup after responding — the SDK auto
 * re-opens on the next `send()`, so the consumer keeps a single
 * long-lived `Handshake` instance.
 */

import { Handshake, PostMessage, postMessage } from 'handshakes'

const hostOrigin = 'http://localhost:5182'

const sendButton = document.getElementById('send') as HTMLButtonElement
const log = document.getElementById('log') as HTMLPreElement

const handshake = Handshake.create({
  transport: postMessage({
    targetOrigin: hostOrigin,
    target: () => {
      const popup = window.open(hostOrigin, 'handshakes-host', 'popup=1,width=400,height=300')
      if (!popup) throw new PostMessage.PopupBlockedError('popup was blocked')
      return popup
    },
  }),
})

handshake.on('open', () => append('open'))
handshake.on('close', (cause) => append(`close${cause ? `: ${cause.message}` : ''}`))
handshake.on('error', (error) => append(`error: ${error.message}`))

sendButton.addEventListener('click', async () => {
  try {
    const { result } = await handshake.send({
      method: 'ping',
      params: [{ message: 'hello from consumer' }],
    })
    append(`result: ${JSON.stringify(result)}`)
  } catch (error) {
    append(`send threw: ${(error as Error).message}`)
  }
})

function append(line: string) {
  log.textContent += `${line}\n`
}
