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

  test('html.render receives `approvalToken`, `record`, `request`, `code`', () => {
    webhookCallback({
      html: {
        authenticate: () => new Response('ok'),
        render: (options) => {
          expectTypeOf(options.approvalToken).toEqualTypeOf<string | undefined>()
          expectTypeOf(options.code).toEqualTypeOf<string | undefined>()
          expectTypeOf(options.record).toEqualTypeOf<
            WebhookCallback.html.ApprovalRecord | undefined
          >()
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          return new Response('ok')
        },
      },
      store: Kv.memory(),
    })
  })

  test('html.authenticate receives `actions`, `record`, `code`, and `request`', () => {
    webhookCallback({
      html: {
        authenticate: (options) => {
          expectTypeOf(options.actions.approve).toEqualTypeOf<
            (
              code: string,
              responseBody?: WebhookCallback.html.ResponseBody | undefined,
            ) => Promise<void>
          >()
          expectTypeOf(options.actions.deny).toEqualTypeOf<
            (
              code: string,
              responseBody?: WebhookCallback.html.ResponseBody | undefined,
            ) => Promise<void>
          >()
          expectTypeOf(options.actions.get).toEqualTypeOf<
            (code: string) => Promise<WebhookCallback.html.ApprovalRecord | undefined>
          >()
          expectTypeOf(options.record).toEqualTypeOf<
            WebhookCallback.html.ApprovalRecord | undefined
          >()
          expectTypeOf(options.code).toEqualTypeOf<string | undefined>()
          expectTypeOf(options.request).toEqualTypeOf<Request>()
          return new Response('ok')
        },
        render: () => new Response('ok'),
      },
      store: Kv.memory(),
    })
  })

  test('html.authenticate is optional', () => {
    webhookCallback({
      html: {
        render: () => new Response('ok'),
      },
      store: Kv.memory(),
    })
  })

  test('store requires an atomic Kv backend', () => {
    expectTypeOf<WebhookCallback.Options['store']>().toEqualTypeOf<Kv.AtomicKv>()
  })

  test('approval records omit consumer-facing correlation handles', () => {
    expectTypeOf<WebhookCallback.html.ApprovalRecord>().not.toHaveProperty('authReqId')
    expectTypeOf<WebhookCallback.html.ApprovalRecord>().not.toHaveProperty('webhookUrl')
    expectTypeOf<WebhookCallback.html.ApprovalRecord['consumer']>().not.toHaveProperty(
      'publicKey',
    )
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
