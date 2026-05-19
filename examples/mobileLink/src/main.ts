import { Wata, mobileLink } from 'wata'
import { Wata as HostWata, mobileLink as hostMobileLink } from 'wata/host'

const log = document.querySelector<HTMLPreElement>('#log')!
const hostUrl = 'https://wallet.example/auth/mobile-link'
const callbackUrl = 'exampleapp://callback'
const privateKey = `0x${'11'.repeat(32)}` as `0x${string}`
const publicKey = '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc'

type Consumer = Wata.Consumer<undefined, readonly [ReturnType<typeof mobileLink>]>
type Host = HostWata.Host<undefined, readonly [ReturnType<typeof hostMobileLink>]>

let consumer!: Consumer
let host!: Host

const open = async (url: string) => {
  log.textContent += `open ${url}\n`
  if (url.startsWith(hostUrl)) await host.mobileLink.handle(url)
  else await consumer.mobileLink.handle(url)
}

consumer = Wata.create({
  transports: [
    mobileLink({
      callbackUrl,
      identity: { deepLinkUrl: hostUrl, publicKey },
      open,
    }),
  ],
})

host = HostWata.create({
  privateKey,
  transports: [
    hostMobileLink({
      open,
      scheme: 'examplewallet',
      universalLink: hostUrl,
    }),
  ],
})

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
