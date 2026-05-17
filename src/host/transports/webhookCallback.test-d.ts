import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import { Kv, MessageSig, Transport, WebhookCallback, Wata, webhookCallback } from 'wata/host'

describe('webhookCallback (host)', () => {
  test('returns a single-exchange host-role transport with `.fetch` + `.listener`', () => {
    const transport = webhookCallback({
      baseUrl: 'https://wallet.example',
      html: {
        authenticate: () => new Response('ok'),
        render: () => new Response('ok'),
      },
      path: '/auth/webhook',
      store: Kv.memory(),
    })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host'>>()
    expectTypeOf(transport.fetch).toEqualTypeOf<(request: Request) => Promise<Response>>()
    expectTypeOf(transport.listener).toBeFunction()
  })

  test('feeds Wata.create as a host transport', () => {
    const transport = webhookCallback({
      html: {
        authenticate: () => new Response('ok'),
        render: () => new Response('ok'),
      },
      store: Kv.memory(),
    })
    const wata = Wata.create({ privateKey: '0x' as Hex.Hex, transport })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
  })

  test('html.render receives `record`, `request`, `req`', () => {
    webhookCallback({
      html: {
        authenticate: () => new Response('ok'),
        render: (options) => {
          expectTypeOf(options.req).toEqualTypeOf<string | undefined>()
          expectTypeOf(options.record).toEqualTypeOf<WebhookCallback.PendingRecord | undefined>()
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          return new Response('ok')
        },
      },
      store: Kv.memory(),
    })
  })

  test('html.authenticate receives `request` and `actions`', () => {
    webhookCallback({
      html: {
        authenticate: (options) => {
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          expectTypeOf(options.actions.approve).toEqualTypeOf<(req: string) => Promise<void>>()
          expectTypeOf(options.actions.deny).toEqualTypeOf<(req: string) => Promise<void>>()
          expectTypeOf(options.actions.get).toEqualTypeOf<
            (req: string) => Promise<WebhookCallback.PendingRecord | undefined>
          >()
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      store: Kv.memory(),
    })
  })

  test('store accepts a Kv.Kv', () => {
    expectTypeOf<WebhookCallback.Options['store']>().toEqualTypeOf<Kv.Kv>()
  })

  test('public options omit derived signature fields', () => {
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('keyid')
    expectTypeOf<WebhookCallback.Options>().not.toHaveProperty('privateKey')
  })

  test('`discovery` contributes a webhook-callback binding', () => {
    const transport = webhookCallback({
      html: {
        authenticate: () => new Response('ok'),
        render: () => new Response('ok'),
      },
      path: '/auth/webhook',
      store: Kv.memory(),
    })
    expectTypeOf(transport.discovery).toEqualTypeOf<Transport.DiscoveryBinding | undefined>()
  })

  test('MessageSig.HttpMessage is re-exported from wata/host', () => {
    expectTypeOf<MessageSig.HttpMessage>().toMatchTypeOf<{
      headers: Record<string, string>
      method: string
      url: string
    }>()
  })
})
