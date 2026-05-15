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

const wata = Wata.create({ transport: postMessage() })

wata.on('open', () => append('open'))
wata.on('close', (cause) => append(`close${cause ? `: ${cause.message}` : ''}`))
wata.on('error', (error) => append(`error: ${error.message}`))

wata.on('request', (event) => {
  append(`request: ${event.method} ${JSON.stringify(event.params)}`)
  current = { id: event.id }
  received.textContent = `${event.method} ${JSON.stringify(event.params)}`
  pending.hidden = false
})

respondButton.addEventListener('click', () => {
  if (!current) return
  const text = message.value || 'pong from host'
  wata.respond(current.id, { message: text })
  append(`respond: ${text}`)
  window.close()
})

function append(line: string) {
  log.textContent += `${line}\n`
}
