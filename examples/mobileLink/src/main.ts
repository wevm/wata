import { Wata, mobileLink } from 'wata'
import { Wata as HostWata, mobileLink as hostMobileLink } from 'wata/host'

const log = document.querySelector<HTMLPreElement>('#log')!
const hostUrl = 'https://wallet.example/auth/mobile-link'
const callbackUrl = 'exampleapp://callback'
const privateKey = `0x${'11'.repeat(32)}` as `0x${string}`
const publicKey = '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc'

let consumerTransport!: ReturnType<typeof mobileLink>
let hostTransport!: ReturnType<typeof hostMobileLink>

const open = async (url: string) => {
  log.textContent += `open ${url}\n`
  if (url.startsWith(hostUrl)) await hostTransport.handle(url)
  else await consumerTransport.handle(url)
}

const consumer = Wata.create({
  transports: [
    mobileLink({
      callbackUrl,
      identity: { deepLinkUrl: hostUrl, publicKey },
      open,
    }),
  ],
})

const host = HostWata.create({
  privateKey,
  transports: [
    hostMobileLink({
      open,
      scheme: 'examplewallet',
      universalLink: hostUrl,
    }),
  ],
})

consumerTransport = consumer.transport
hostTransport = host.transports[0]!

host.on('request', (event) => {
  if (event.method === 'ping')
    return {
      message: 'pong from host',
      transport: event.transport,
    }
  return undefined
})

document.querySelector<HTMLButtonElement>('#ping')!.addEventListener('click', async () => {
  log.textContent = ''
  const { result } = await consumer.send({ method: 'ping', params: [] })
  log.textContent += `result ${JSON.stringify(result, null, 2)}\n`
})
