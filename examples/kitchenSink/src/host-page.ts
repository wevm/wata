import { host } from './host.js'

const status = document.getElementById('status') as HTMLElement

status.textContent = `waiting for ${host.role} request`

host.onOpen(() => {
  status.textContent = 'ready'
})

host.onError((error) => {
  status.textContent = error.message
})
