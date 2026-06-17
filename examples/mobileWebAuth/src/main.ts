import { Wata } from 'wata/consumer'
import { mobileWebAuth } from 'wata/consumer/transports/mobileWebAuth'
import { Wata as HostWata, mobileWebAuth as hostMobileWebAuth } from 'wata/host'
import * as Identity from 'wata/identity'

const callback = 'com.example.app://callback'
const consumerOrigin = 'https://app.example'
const hostOrigin = 'https://wallet.example'
const hostUrl = `${hostOrigin}/auth/mobile`

const host = HostWata.create({
  baseUrl: hostOrigin,
  identity: Identity.fromPrivateKey(
    '0x2222222222222222222222222222222222222222222222222222222222222222',
  ),
  meta: { name: 'Example Wallet' },
  transports: [
    hostMobileWebAuth({
      fetch: async (): Promise<Response> =>
        Response.json({
          callback_urls: [callback],
          id: 'app.example',
          origin: consumerOrigin,
          version: '1.0',
        }),
      html: {
        authenticate: async ({ actions, request }) => {
          const form = await request.formData()
          return await actions.approve(String(form.get('state')))
        },
        render: ({ authorization }) => new Response(authorization.state),
      },
      path: '/auth/mobile',
    }),
  ],
})

const hostSession = await host.start()

hostSession.onRequest(async (event) => {
  if (event.method === 'ping')
    await event.respond({ message: 'pong from host', transport: event.transport })
})

const consumer = Wata.create({
  baseUrl: consumerOrigin,
  meta: { name: 'Example App' },
  transports: [
    mobileWebAuth({
      callback,
      fetch: async (input): Promise<Response> => await host.fetch(new Request(String(input))),
      host: hostOrigin,
      openAuthSession: async ({ authorizationUrl }) => {
        const get = await host.fetch(new Request(authorizationUrl))
        const state = await get.text()
        const form = new FormData()
        form.set('state', state)
        const post = await host.fetch(new Request(hostUrl, { body: form, method: 'POST' }))
        return post.headers.get('location') ?? undefined
      },
    }),
  ],
})

const session = await consumer.start()

const button = document.getElementById('send') as HTMLButtonElement
const log = document.getElementById('log') as HTMLPreElement

button.addEventListener('click', async () => {
  log.textContent = 'waiting...\n'
  try {
    const response = await session.send({ method: 'ping', params: [] })
    log.textContent += `${JSON.stringify(response.result, undefined, 2)}\n`
  } catch (cause) {
    log.textContent += `${(cause as Error).name}: ${(cause as Error).message}\n`
  }
})
