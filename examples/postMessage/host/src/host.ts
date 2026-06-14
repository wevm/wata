/**
 * Minimal host-side example for the `postMessage` transport.
 *
 * Auto-detects the consumer (iframe parent or popup opener), opens a
 * `Wata` session, and lets the user manually respond to each
 * inbound request via a text input + button.
 */

import { Wata, postMessage } from 'wata/host'

const pending = document.getElementById('pending') as HTMLDivElement
const received = document.getElementById('received') as HTMLElement
const message = document.getElementById('message') as HTMLInputElement
const respondButton = document.getElementById('respond') as HTMLButtonElement
const log = document.getElementById('log') as HTMLPreElement

let current: { id: number | string } | undefined

// The consumer conveys its origin out of band on the host URL (spec §3.1).
const wata = Wata.create({
  transports: [
    postMessage({ targetOrigin: new URL(location.href).searchParams.get('origin') ?? undefined }),
  ],
})

wata.onOpen(() => append('open'))
wata.onClose((cause) => append(`close${cause ? `: ${cause.message}` : ''}`))
wata.onError((error) => append(`error: ${error.message}`))

wata.onRequest((event) => {
  append(`request: ${event.method} ${JSON.stringify(event.params)}`)
  current = { id: event.id }
  received.textContent = `${event.method} ${JSON.stringify(event.params)}`
  pending.hidden = false
})

respondButton.addEventListener('click', async () => {
  if (!current) return
  const text = message.value || 'pong from host'
  await wata.respond(current.id, { message: text })
  append(`respond: ${text}`)
  window.close()
})

function append(line: string) {
  log.textContent += `${line}\n`
}
