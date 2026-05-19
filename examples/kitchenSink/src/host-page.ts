import { host } from './host.js'

const status = document.getElementById('status') as HTMLElement

status.textContent = `waiting for ${host.role} request`

host.on('open', () => {
  status.textContent = 'ready'
})

host.on('error', (error) => {
  status.textContent = error.message
})
