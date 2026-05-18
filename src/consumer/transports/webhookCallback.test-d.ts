import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import { Kv, Transport, WebhookCallback, Wata, webhookCallback } from 'wata'

describe('webhookCallback (consumer)', () => {
  test('returns a single-exchange consumer-role transport with `.fetch` + `.listener`', () => {
    const transport = webhookCallback({
      host: 'https://wallet.example',
      path: '/cb',
      store: Kv.memory(),
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
    expectTypeOf(transport.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(transport.listener).toBeFunction()
    expectTypeOf(transport.cancel).toEqualTypeOf<() => Promise<void>>()
    expectTypeOf(transport.callbackUrls).toEqualTypeOf<readonly string[] | undefined>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const transport = webhookCallback({
      host: 'https://wallet.example',
      path: '/cb',
      store: Kv.memory(),
    })
    const wata = Wata.create({
      baseUrl: 'https://acme.dev',
      meta: { name: 'Acme CLI' },
      privateKey: '0x' as Hex.Hex,
      transport,
    })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('path is the consumer callback path', () => {
    expectTypeOf<WebhookCallback.Options['path']>().toEqualTypeOf<string>()
  })

  test('public options omit derived signature and callback URL fields', () => {
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('keyid')
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('privateKey')
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('webhookUrl')
  })

  test('store accepts a Kv.Kv', () => {
    expectTypeOf<WebhookCallback.Options['store']>().toEqualTypeOf<Kv.Kv>()
  })

  test('host accepts string OR pre-parsed HostDocument', () => {
    expectTypeOf<WebhookCallback.Options['host']>().toMatchTypeOf<string | object>()
  })

  test('prompt omits consumer-facing correlation handles', () => {
    expectTypeOf<WebhookCallback.Prompt>().not.toHaveProperty('authReqId')
  })
})
