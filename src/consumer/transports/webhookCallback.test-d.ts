import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import { Identity, Store, Transport, WebhookCallback, Wata, webhookCallback } from 'wata'

function fromPrivateKey(privateKey: Hex.Hex) {
  return Identity.fromPrivateKey(privateKey)
}

describe('webhookCallback (consumer)', () => {
  test('returns a single-exchange consumer-role transport with `.fetch`', () => {
    const transport = webhookCallback({
      host: 'https://wallet.example',
      path: '/cb',
      store: Store.memory(),
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<
      Transport.Transport<
        'consumer',
        'webhookCallback',
        { sendValue: WebhookCallback.Registration }
      >
    >()
    expectTypeOf(transport.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(transport.cancel).toEqualTypeOf<() => Promise<void>>()
    expectTypeOf(transport.callbackUrls).toEqualTypeOf<readonly string[] | undefined>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = webhookCallback({
      host: 'https://wallet.example',
      path: '/cb',
      store: Store.memory(),
    })
    const wata = Wata.create({
      baseUrl: 'https://acme.dev',
      meta: { name: 'Acme CLI' },
      identity: fromPrivateKey('0x' as Hex.Hex),
      transports: [transport],
    })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('Wata.send returns registration metadata for a single webhookCallback transport', async () => {
    const transport = webhookCallback({
      host: 'https://wallet.example',
      path: '/cb',
      store: Store.memory(),
    })
    const wata = Wata.create({
      baseUrl: 'https://acme.dev',
      meta: { name: 'Acme CLI' },
      identity: fromPrivateKey('0x' as Hex.Hex),
      transports: [transport],
    })
    const registration = await wata.send({ method: 'ping', params: [] })
    expectTypeOf(registration).toEqualTypeOf<WebhookCallback.Registration>()
    expectTypeOf(registration.verificationUri).toEqualTypeOf<string>()
  })

  test('path is the consumer callback path', () => {
    expectTypeOf<WebhookCallback.Options['path']>().toEqualTypeOf<string>()
  })

  test('public options omit derived signature and callback URL fields', () => {
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('keyid')
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('onPrompt')
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('privateKey')
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('webhookUrl')
  })

  test('store accepts a Store.Store', () => {
    expectTypeOf<WebhookCallback.Options['store']>().toEqualTypeOf<Store.Store>()
  })

  test('host accepts string OR pre-parsed HostDocument', () => {
    expectTypeOf<WebhookCallback.Options['host']>().toMatchTypeOf<string | object>()
  })

  test('registration omits consumer-facing correlation handles', () => {
    expectTypeOf<WebhookCallback.Registration>().not.toHaveProperty('authReqId')
  })
})
