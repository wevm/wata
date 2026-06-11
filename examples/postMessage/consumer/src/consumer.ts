/**
 * Minimal consumer-side example for the `postMessage` transport.
 *
 * Opens the host in a popup (cross-origin), opens a `Wata` session
 * over `postMessage`, and sends a `ping` request when the button is
 * clicked. The host closes its popup after responding — the SDK auto
 * re-opens on the next `send()`, so the consumer keeps a single
 * long-lived `Wata` instance.
 */

import { Wata, PostMessage, postMessage } from 'wata'

const hostOrigin = 'http://localhost:5182'

const sendButton = document.getElementById('send') as HTMLButtonElement
const log = document.getElementById('log') as HTMLPreElement

const wata = Wata.create({
  transports: [
    postMessage({
      host: hostOrigin,
      target: ({ host }) => {
        // Convey our origin out of band so the host can pin it (spec §3.1).
        const url = `${host}?origin=${encodeURIComponent(location.origin)}`
        const popup = window.open(url, 'wata-host', 'popup=1,width=400,height=300')
        if (!popup) throw new PostMessage.PopupBlockedError('popup was blocked')
        return popup
      },
    }),
  ],
})

wata.on('open', () => append('open'))
wata.on('close', (cause) => append(`close${cause ? `: ${cause.message}` : ''}`))
wata.on('error', (error) => append(`error: ${error.message}`))

sendButton.addEventListener('click', async () => {
  try {
    const { result } = await wata.send({
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
