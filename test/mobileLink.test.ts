import { describe, expect, test } from 'vp/test'
import {
  Crypto,
  Discovery,
  Identity,
  MobileLink,
  Session as ConsumerSession,
  Wata,
  mobileLink,
} from 'wata'
import { Session, Wata as HostWata, mobileLink as hostMobileLink } from 'wata/host'
import { consumerWellknown } from 'wata/server'

/** Bridge a `{ fetch }` server handler into a `typeof fetch` override. */
function serverFetch(server: { fetch: (request: Request) => Promise<Response> }): typeof fetch {
  return (input, init) => server.fetch(new Request(input, init))
}

describe('mobileLink', () => {
  test('handshakes and exchanges messages end to end over deep links', async () => {
    const hostIdentity = Crypto.randomKeypair()
    const consumerOrigin = 'https://app.example'
    const hostOrigin = 'https://wallet.example'
    const returnUrl = `${consumerOrigin}/urpc/cb`

    // Consumer pins this host doc (identity_pubkey + mobile-link binding).
    const hostDoc = Discovery.parseHost({
      id: 'wallet.example',
      identity_pubkey: Crypto.encodePublicKey(hostIdentity.publicKey),
      name: 'Wallet',
      origin: hostOrigin,
      transports: {
        'mobile-link': { scheme: 'examplewallet', universal_link: `${hostOrigin}/urpc` },
      },
      version: '1.0',
    })

    // Host fetches the consumer's consumer.json to verify the callback.
    const consumerWk = consumerWellknown({
      document: {
        callback_urls: [returnUrl],
        id: 'app.example',
        name: 'App',
        origin: consumerOrigin,
        version: '1.0',
      },
    })

    // In-memory deep-link bus wiring each side's openLink to the other's
    // session handleUrl.
    // Pin the host at construction so `consumer.start()` needs no start-time host.
    let consumerTransport!: MobileLink.MobileLink<{ host: Discovery.HostDocument }>
    let consumerSession!: ConsumerSession.Session<undefined, typeof consumerTransport>
    let hostSession!: Session.Session<undefined, ReturnType<typeof hostMobileLink>>
    let hostTransport!: ReturnType<typeof hostMobileLink>
    consumerTransport = mobileLink({
      host: hostDoc,
      id: consumerOrigin,
      openLink: (url) => {
        void hostSession.handleUrl(url)
      },
      returnUrl,
    })
    hostTransport = hostMobileLink({
      fetch: serverFetch(consumerWk),
      openLink: (url) => {
        consumerSession.handleUrl(url)
      },
      scheme: 'examplewallet',
      universalLink: `${hostOrigin}/urpc`,
    })

    const consumer = Wata.create({ baseUrl: consumerOrigin, transports: [consumerTransport] })
    const host = HostWata.create({
      baseUrl: hostOrigin,
      identity: Identity.fromPrivateKey(hostIdentity.privateKey),
      meta: { name: 'Wallet' },
      transports: [hostTransport],
    })
    consumerSession = await consumer.start()
    hostSession = await host.start()
    hostSession.onRequest(async (event) => {
      if (event.method === 'ping') await event.respond('pong')
      if (event.method === 'echo') await event.respond(event.params)
    })

    // First exchange runs the handshake (initial deep link + signed callback).
    const first = await consumerSession.send({ method: 'ping', params: [] })
    expect(first.result).toBe('pong')

    // Second exchange runs over the keyed, ongoing session.
    const second = await consumerSession.send({ method: 'echo', params: ['hello'] })
    expect(second.result).toEqual(['hello'])

    await consumer.close()
    await host.close()
  })
})
