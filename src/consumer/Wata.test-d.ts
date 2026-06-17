import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import {
  Discovery,
  Identity,
  Store,
  Rpc,
  Schema,
  Session,
  Transport,
  Wata,
  WebhookCallback,
  deviceCode,
  loopback,
  mobileWebAuth,
  postMessage,
  webhookCallback,
} from 'wata'
import { Wata as ConsumerWata, loopback as loopback_consumer } from 'wata/consumer'
import { deviceCode as deviceCode_consumer } from 'wata/consumer/transports/deviceCode'
import { mobileWebAuth as mobileWebAuth_entry } from 'wata/consumer/transports/mobileWebAuth'
import { postMessage as postMessage_entry } from 'wata/consumer/transports/postMessage'
import { webhookCallback as webhookCallback_consumer } from 'wata/consumer/transports/webhookCallback'
import {
  Discovery as HostDiscovery,
  Schema as HostSchema,
  Session as HostSession,
  Wata as HostWata,
  deviceCode as hostDeviceCode,
  mobileWebAuth as hostMobileWebAuth,
  postMessage as hostPostMessage,
  webhookCallback as hostWebhookCallback,
} from 'wata/host'
import { deviceCode as deviceCode_host } from 'wata/host/transports/deviceCode'
import { mobileWebAuth as mobileWebAuth_host } from 'wata/host/transports/mobileWebAuth'
import { postMessage as postMessage_host } from 'wata/host/transports/postMessage'
import { webhookCallback as webhookCallback_host } from 'wata/host/transports/webhookCallback'
import * as Identity_entry from 'wata/identity'
import { z } from 'zod/mini'

const privateKey = '0x' as Hex.Hex
const identity = Identity.fromPrivateKey(privateKey)
declare const portHandle: MessagePort
declare const popupHandle: Window

function fromPrivateKey(privateKey: Hex.Hex) {
  return Identity.fromPrivateKey(privateKey)
}

const schema = Schema.create({
  methods: {
    eth_sign: Schema.method({
      params: z.tuple([z.string(), z.string()]),
      result: z.string(),
    }),
    ping: Schema.method({
      params: z.tuple([]),
      result: z.object({ ok: z.literal(true) }),
    }),
  },
})
const open_schema = Schema.extend(Schema.rpc(), { methods: schema.methods })

const context = z.object({
  account: z.string(),
  chainId: z.number(),
})

const context_extended = z.object({
  account: z.optional(z.string()),
  chainId: z.optional(z.number()),
  origin: z.string(),
})

const hostSchema = HostSchema.create({
  methods: {
    ping: HostSchema.method({
      params: z.tuple([]),
      result: z.object({ ok: z.literal(true) }),
    }),
  },
})

function namedPair<const name extends string>(name: name) {
  const { consumer, host } = loopback()
  return {
    consumer: { ...consumer, name } as Transport.Transport<'consumer', name>,
    host: { ...host, name } as Transport.Transport<'host', name>,
  }
}

describe('create', () => {
  test('client-safe subpaths expose consumer Wata and transport factories', () => {
    expectTypeOf(ConsumerWata.create).toEqualTypeOf<typeof Wata.create>()
    expectTypeOf(Identity_entry.fromPrivateKey).toEqualTypeOf<typeof Identity.fromPrivateKey>()
    expectTypeOf(deviceCode_consumer).toEqualTypeOf<typeof deviceCode>()
    expectTypeOf(loopback_consumer).toEqualTypeOf<typeof loopback>()
    expectTypeOf(mobileWebAuth_entry).toEqualTypeOf<typeof mobileWebAuth>()
    expectTypeOf(postMessage_entry).toEqualTypeOf<typeof postMessage>()
    expectTypeOf(webhookCallback_consumer).toEqualTypeOf<typeof webhookCallback>()
    expectTypeOf(deviceCode_host).toEqualTypeOf<typeof hostDeviceCode>()
    expectTypeOf(mobileWebAuth_host).toEqualTypeOf<typeof hostMobileWebAuth>()
    expectTypeOf(postMessage_host).toEqualTypeOf<typeof hostPostMessage>()
    expectTypeOf(webhookCallback_host).toEqualTypeOf<typeof hostWebhookCallback>()
  })

  test('returns a Consumer config whose start() resolves the session', async () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(wata).toMatchTypeOf<{ start: Function }>()
    // Config carries no live surface; that lives on the session.
    expectTypeOf(wata).not.toMatchTypeOf<{ send: Function }>()
    const session = await wata.start()
    expectTypeOf(session).toMatchTypeOf<{ send: Function }>()
    expectTypeOf(session).toMatchTypeOf<{ notify: Function }>()
  })

  test('multiple consumer transports expose child handles by transport name', async () => {
    const alpha = namedPair('alpha')
    const beta = namedPair('beta')
    const wata = Wata.create({ transports: [alpha.consumer, beta.consumer], schema })

    expectTypeOf(wata.alpha).toMatchTypeOf<{ start: Function }>()
    expectTypeOf(wata.beta).toMatchTypeOf<{ start: Function }>()
    expectTypeOf(wata.transports).toEqualTypeOf<
      readonly [Transport.Transport<'consumer', 'alpha'>, Transport.Transport<'consumer', 'beta'>]
    >()
    // @ts-expect-error multiple transports do not expose a top-level start
    wata.start()
    const alphaSession = await wata.alpha.start()
    expectTypeOf(alphaSession).toMatchTypeOf<{ send: Function }>()
  })

  test('returns a Host config whose start() resolves the session', async () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
    expectTypeOf(wata).toMatchTypeOf<{ start: Function }>()
    expectTypeOf(wata).not.toMatchTypeOf<{ onRequest: Function }>()
    const session = await wata.start()
    expectTypeOf(session).toMatchTypeOf<{ onRequest: Function }>()
  })

  test('accepts Schema imported from the host entrypoint', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema: hostSchema }).start()
    wata.onRequest((event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping'>()
      event.respond({ ok: true })
      // @ts-expect-error wrong shape for ping
      event.respond('not the ping result')
    })
  })

  test('Session.compose fans request handlers across composed sessions', async () => {
    const device = namedPair('deviceCode')
    const webhook = namedPair('webhookCallback')
    const host = HostWata.create({
      transports: [device.host, webhook.host],
      schema,
    })

    const session = await HostSession.compose([
      host.deviceCode.start(),
      host.webhookCallback.start(),
    ])

    expectTypeOf(session.role).toEqualTypeOf<'host'>()
    expectTypeOf(session).toMatchTypeOf<{ onRequest: Function }>()
    // composed handle fans subscriptions only — no top-level send
    expectTypeOf(session).not.toMatchTypeOf<{ send: Function }>()

    session.onRequest((event) => {
      expectTypeOf(event.transport).toEqualTypeOf<'deviceCode' | 'webhookCallback'>()
      expectTypeOf(event.method).toEqualTypeOf<'eth_sign' | 'ping'>()
    })
  })
})

describe('Consumer.send', () => {
  test('infers the result type from the schema entry', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer], schema }).start()

    const ping = await wata.send({ method: 'ping', params: [] })
    expectTypeOf(ping.result).toEqualTypeOf<{ ok: true }>()

    const sig = await wata.send({ method: 'eth_sign', params: ['0x', '0x'] })
    expectTypeOf(sig.result).toEqualTypeOf<string>()
  })

  test('open schemas infer known methods and fall back for unknown methods', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ schema: open_schema, transports: [consumer] }).start()

    const ping = await wata.send({ method: 'ping', params: [] })
    expectTypeOf(ping.result).toEqualTypeOf<{ ok: true }>()

    const fallback = await wata.send({ method: 'wallet_connect', params: [{ chains: [] }] })
    expectTypeOf(fallback.result).toEqualTypeOf<unknown>()

    // @ts-expect-error known methods still use their precise params
    wata.send({ method: 'ping', params: ['oops'] })
    // @ts-expect-error fallback params must be JSON-RPC params
    wata.send({ method: 'wallet_connect', params: null })
  })

  test('rejects unknown methods at compile time', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer], schema }).start()
    // @ts-expect-error 'nope' is not in the schema
    wata.send({ method: 'nope', params: [] })
  })

  test('rejects wrong params shape at compile time', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer], schema }).start()
    // @ts-expect-error params must be [number, number]-shaped per schema… or []
    wata.send({ method: 'ping', params: ['oops'] })
  })

  test('returns { id, result } shape (preserves JSON-RPC identity)', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer], schema }).start()
    const out = await wata.send({ method: 'ping', params: [] })
    expectTypeOf(out.id).toEqualTypeOf<Rpc.Id>()
  })

  test('uses the default account/chain request context shape', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer], schema }).start()
    wata.send({
      context: { account: '0xabc', chainId: 1 },
      method: 'ping',
      params: [],
    })
    wata.send({
      // @ts-expect-error default chainId must be a number
      context: { account: '0xabc', chainId: '1' },
      method: 'ping',
      params: [],
    })
    // @ts-expect-error context must use the default account/chain shape
    wata.send({ context: '0xabc', method: 'ping', params: [] })
  })

  test('infers request context from the Wata context schema', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ context, transports: [consumer], schema }).start()
    wata.send({
      context: { account: '0xabc', chainId: 1 },
      method: 'ping',
      params: [],
    })
    wata.send({
      // @ts-expect-error chainId must match the Wata context schema
      context: { account: '0xabc', chainId: '1' },
      method: 'ping',
      params: [],
    })
  })

  test('supports app-specific request context extensions', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({
      context: context_extended,
      transports: [consumer],
      schema,
    }).start()
    wata.send({
      context: { account: '0xabc', chainId: 1, origin: 'https://app.example' },
      method: 'ping',
      params: [],
    })
  })

  test('falls back to unknown when no schema is supplied', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer] }).start()
    const out = await wata.send({ method: 'whatever', params: [] })
    expectTypeOf(out.result).toEqualTypeOf<unknown>()
  })
})

describe('Consumer.notify', () => {
  test('inherits the same method-name narrowing as send', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer], schema }).start()
    wata.notify({ method: 'ping', params: [] })
    // @ts-expect-error 'nope' is not in the schema
    wata.notify({ method: 'nope', params: [] })
  })

  test('accepts unknown methods when the schema is open', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ schema: open_schema, transports: [consumer] }).start()
    wata.notify({ method: 'wallet_connect', params: [] })
    // @ts-expect-error known methods still use their precise params
    wata.notify({ method: 'ping', params: ['oops'] })
  })
})

describe('Host.notify', () => {
  test('inherits the same method-name narrowing as send', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema }).start()
    wata.notify({ method: 'ping', params: [] })
    // @ts-expect-error 'nope' is not in the schema
    wata.notify({ method: 'nope', params: [] })
    // @ts-expect-error params must match the schema entry
    wata.notify({ method: 'eth_sign', params: ['0x'] })
  })

  test('accepts unknown methods when the schema is open', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ schema: open_schema, transports: [host] }).start()
    wata.notify({ method: 'wallet_connect', params: [] })
    // @ts-expect-error known methods still use their precise params
    wata.notify({ method: 'ping', params: ['oops'] })
  })
})

describe('Host events', () => {
  test('`request` is a discriminated union over method (params + respond narrow together)', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema }).start()
    wata.onRequest((event) => {
      expectTypeOf(event.meta).toEqualTypeOf<
        HostWata.HostEventMeta<Transport.Transport<'host', 'loopback'>>
      >()
      // @ts-expect-error loopback does not expose origin metadata
      expectTypeOf(event.meta.origin).toEqualTypeOf<never>()
      expectTypeOf(event.meta.transport).toEqualTypeOf<'loopback'>()
      expectTypeOf(event.method).toEqualTypeOf<'ping' | 'eth_sign'>()
      expectTypeOf(event.context).toEqualTypeOf<Rpc.RequestContext | undefined>()
      expectTypeOf(event.request.context).toEqualTypeOf<Rpc.RequestContext | undefined>()
      if (event.context) {
        expectTypeOf(event.context.account).toEqualTypeOf<string | undefined>()
        expectTypeOf(event.context.chainId).toEqualTypeOf<number | undefined>()
      }
      if (event.method === 'ping') {
        expectTypeOf(event.params).toMatchTypeOf<readonly []>()
        // narrowed: respond accepts the ping result shape
        event.respond({ ok: true })
        // @ts-expect-error wrong shape for ping
        event.respond('not the ping result')
      }
      if (event.method === 'eth_sign') {
        expectTypeOf(event.params).toMatchTypeOf<readonly [string, string]>()
        // narrowed: respond accepts a string
        event.respond('0xdeadbeef')
        // @ts-expect-error wrong shape for eth_sign
        event.respond({ ok: true })
      }
    })
    // @ts-expect-error broad request listeners respond with event.respond, not result returns
    wata.onRequest(() => ({ ok: true }))
  })

  test('`notification` payload is narrowed against the schema', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema }).start()
    wata.onNotification((event) => {
      // @ts-expect-error loopback does not expose origin metadata
      expectTypeOf(event.meta.origin).toEqualTypeOf<never>()
      expectTypeOf(event.meta.transport).toEqualTypeOf<'loopback'>()
      expectTypeOf(event.method).toEqualTypeOf<'ping' | 'eth_sign'>()
      if (event.method === 'eth_sign')
        expectTypeOf(event.params).toMatchTypeOf<readonly [string, string]>()
    })
  })

  test('method-scoped listeners keep exact known-method types on open schemas', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ schema: open_schema, transports: [host] }).start()

    wata.onRequest('ping', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping'>()
      expectTypeOf(event.params).toMatchTypeOf<readonly []>()
      event.respond({ ok: true })
      // @ts-expect-error wrong shape for ping
      event.respond('not the ping result')
    })
    wata.onRequest('ping', () => ({ ok: true as const }))
    wata.onRequest('ping', async () => ({ ok: true as const }))
    // @ts-expect-error listener returns must match the method result
    wata.onRequest('ping', () => 'not the ping result')
    // @ts-expect-error async listener returns must match the method result
    wata.onRequest('ping', async () => 'not the ping result')
    wata.onRequest('wallet_connect', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'wallet_connect'>()
      expectTypeOf(event.params).toMatchTypeOf<Rpc.Params>()
      event.respond({ opaque: true })
    })
    wata.onRequest('wallet_connect', () => ({ opaque: true }))
  })

  test('method-scoped listeners reject unknown methods on closed schemas', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema }).start()
    // @ts-expect-error closed schemas only accept known request methods
    wata.onRequest('wallet_connect', () => {})
  })

  test('per-transport sessions narrow `request` metadata to their transport', async () => {
    const { host } = loopback()
    const wata = HostWata.create({
      schema,
      transports: [hostPostMessage({ target: () => popupHandle }), host],
    })
    const postMessageSession = await wata.postMessage.start()
    postMessageSession.onRequest((event) => {
      expectTypeOf(event.meta.transport).toEqualTypeOf<'postMessage'>()
      expectTypeOf(event.meta.origin).toEqualTypeOf<string>()
    })
    const loopbackSession = await wata.loopback.start()
    loopbackSession.onRequest((event) => {
      expectTypeOf(event.meta.transport).toEqualTypeOf<'loopback'>()
      // @ts-expect-error loopback does not expose origin metadata
      expectTypeOf(event.meta.origin).toEqualTypeOf<never>()
    })
  })

  test('MessagePort postMessage metadata does not expose origin', async () => {
    const wata = await HostWata.create({
      schema,
      transports: [hostPostMessage({ target: () => portHandle })],
    }).start()
    wata.onRequest((event) => {
      expectTypeOf(event.meta.transport).toEqualTypeOf<'postMessage'>()
      // @ts-expect-error MessagePort-backed postMessage does not expose origin metadata
      expectTypeOf(event.meta.origin).toEqualTypeOf<never>()
    })
  })

  test('`request` context is narrowed against the Wata context schema', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ context, transports: [host], schema }).start()
    wata.onRequest((event) => {
      expectTypeOf(event.context).toEqualTypeOf<z.output<typeof context> | undefined>()
      expectTypeOf(event.request.context).toEqualTypeOf<z.output<typeof context> | undefined>()
      if (event.context) expectTypeOf(event.context.chainId).toEqualTypeOf<number>()
    })
  })

  test('lifecycle event payloads', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema }).start()
    wata.onClose((payload) => {
      expectTypeOf(payload).toEqualTypeOf<Error | undefined>()
    })
    wata.onError((payload) => {
      expectTypeOf(payload).toEqualTypeOf<Error>()
    })
    wata.onEnvelope((envelope, meta) => {
      if (envelope.type === 'rpc-requests')
        expectTypeOf(envelope.payload).toEqualTypeOf<Session.RpcRequestsPayload<typeof schema>>()
      if (envelope.type === 'rpc-responses')
        expectTypeOf(envelope.payload).toEqualTypeOf<Session.RpcResponsesPayload<typeof schema>>()
      expectTypeOf(meta).toEqualTypeOf<Session.EnvelopeMeta>()
    })
  })

  test('rejects unknown event types at compile time', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema }).start()
    // @ts-expect-error 'onNope' is not a known event subscriber
    wata.onNope(() => {})
  })
})

describe('Consumer events', () => {
  test('exposes lifecycle, rpc, and notification events (no `request`)', async () => {
    const { consumer } = loopback()
    const wata = await Wata.create({ transports: [consumer], schema }).start()
    wata.onClose(() => {})
    wata.onError(() => {})
    wata.onNotification((event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping' | 'eth_sign'>()
      if (event.method === 'eth_sign')
        expectTypeOf(event.params).toMatchTypeOf<readonly [string, string]>()
    })
    wata.onEnvelope((envelope, meta) => {
      if (envelope.type === 'rpc-requests')
        expectTypeOf(envelope.payload).toEqualTypeOf<Session.RpcRequestsPayload<typeof schema>>()
      if (envelope.type === 'rpc-responses')
        expectTypeOf(envelope.payload).toEqualTypeOf<Session.RpcResponsesPayload<typeof schema>>()
      expectTypeOf(meta).toEqualTypeOf<Session.EnvelopeMeta>()
      expectTypeOf(meta.direction).toEqualTypeOf<'incoming' | 'outgoing'>()
      expectTypeOf(meta.transport).toEqualTypeOf<string>()
    })
    // @ts-expect-error consumers don't receive `request`
    wata.onRequest(() => {})
  })

  test('multiple transports keep webhook registration metadata on its child session', async () => {
    const { consumer } = loopback()
    const transport = webhookCallback({
      host: 'https://wallet.example',
      path: '/cb',
      store: Store.memory(),
    })
    const wata = Wata.create({
      baseUrl: 'https://acme.dev',
      identity: fromPrivateKey(privateKey),
      transports: [consumer, transport],
    })
    const webhookSession = await wata.webhookCallback.start()
    const registration = await webhookSession.send({ method: 'ping', params: [] })
    expectTypeOf(registration).toEqualTypeOf<WebhookCallback.Registration>()
    const loopbackSession = await wata.loopback.start()
    const out = await loopbackSession.send({ method: 'ping', params: [] })
    expectTypeOf(out).toEqualTypeOf<Session.SendResult<unknown>>()
  })
})

describe('on returns AbortController', () => {
  test('subscription returns an AbortController', async () => {
    const { host } = loopback()
    const wata = await HostWata.create({ transports: [host], schema }).start()
    const controller = wata.onClose(() => {})
    expectTypeOf(controller).toEqualTypeOf<AbortController>()
  })
})

describe('baseUrl + meta options', () => {
  test('consumer accepts `baseUrl` and `meta` typed as Discovery.Meta', () => {
    const { consumer } = loopback()
    const meta: Discovery.Meta = { name: 'Acme CLI' }
    Wata.create({ baseUrl: 'https://acme.dev', meta, transports: [consumer] })
  })

  test('consumer accepts signer-backed `identity`', () => {
    const { consumer } = loopback()
    Wata.create({ identity, transports: [consumer] })
  })

  test('host accepts `baseUrl` and `meta` typed as host Discovery.Meta', () => {
    const { host } = loopback()
    const meta: HostDiscovery.Meta = { name: 'Wallet' }
    HostWata.create({ baseUrl: 'https://wallet.example', meta, identity, transports: [host] })
  })

  test('host accepts signer-backed `identity`', () => {
    const { host } = loopback()
    HostWata.create({ identity, transports: [host] })
  })
})
