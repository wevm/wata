import { host } from './host.js'

const status = document.getElementById('status') as HTMLElement

status.textContent = `waiting for ${host.role} request`

const session = await host.postMessage.start()

status.textContent = 'ready'

session.onRequest(async (event) => {
  await event.respond({ message: 'pong from host', transport: event.transport })
})

session.onError((error) => {
  status.textContent = error.message
})
