import { Wata, mobileWebAuth } from 'wata'
import { Wata as HostWata, mobileWebAuth as hostMobileWebAuth } from 'wata/host'

const callbackUrl = 'com.example.app://callback'
const consumerId = 'https://app.example'
const hostOrigin = 'https://wallet.example'
const hostUrl = `${hostOrigin}/auth/mobile`

let consumer!: Wata.Consumer<undefined, readonly [ReturnType<typeof mobileWebAuth>]>

const host = HostWata.create({
  baseUrl: hostOrigin,
  meta: { name: 'Example Wallet' },
  privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
  transports: [
    hostMobileWebAuth({
      fetch: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            callback_urls: [callbackUrl],
            id: 'app.example',
            origin: consumerId,
            version: '1.0',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      html: {
        authenticate: async ({ actions, request }) => {
          const form = await request.formData()
          return Response.redirect(await actions.approve(String(form.get('state'))), 302)
        },
        render: ({ record }) => new Response(record?.state),
      },
      path: '/auth/mobile',
    }),
  ],
})

host.on('request', async (event) => {
  await event.respond({ message: 'pong from host', transport: event.transport })
})

consumer = Wata.create({
  baseUrl: consumerId,
  meta: { name: 'Example App' },
  transports: [
    mobileWebAuth({
      callbackUrl,
      fetch: async (input): Promise<Response> => await host.fetch(new Request(String(input))),
      host: hostOrigin,
      open: async (url) => {
        const get = await host.mobileWebAuth.fetch(new Request(url))
        const state = await get.text()
        const form = new FormData()
        form.set('state', state)
        const post = await host.mobileWebAuth.fetch(
          new Request(hostUrl, { body: form, method: 'POST' }),
        )
        const location = post.headers.get('location')
        if (location) await consumer.mobileWebAuth.handle(location)
      },
    }),
  ],
})

const button = document.getElementById('send') as HTMLButtonElement
const log = document.getElementById('log') as HTMLPreElement

button.addEventListener('click', async () => {
  log.textContent = 'waiting...\n'
  try {
    const response = await consumer.mobileWebAuth.send({ method: 'ping', params: [] })
    log.textContent += `${JSON.stringify(response.result, undefined, 2)}\n`
  } catch (cause) {
    log.textContent += `${(cause as Error).name}: ${(cause as Error).message}\n`
  }
})
