import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import {
  Discovery,
  Identity,
  Store,
  Rpc,
  Schema,
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

  test('returns a Consumer when given a consumer transport', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(wata).toMatchTypeOf<{ start: () => Promise<void> }>()
    expectTypeOf(wata).toMatchTypeOf<{ send: Function }>()
    expectTypeOf(wata).toMatchTypeOf<{ notify: Function }>()
  })

  test('multiple consumer transports expose child sessions by transport name', () => {
    const alpha = namedPair('alpha')
    const beta = namedPair('beta')
    const wata = Wata.create({ transports: [alpha.consumer, beta.consumer], schema })

    expectTypeOf(wata.alpha).toMatchTypeOf<{ send: Function }>()
    expectTypeOf(wata.beta).toMatchTypeOf<{ send: Function }>()
    expectTypeOf(wata.transports).toEqualTypeOf<
      readonly [Transport.Transport<'consumer', 'alpha'>, Transport.Transport<'consumer', 'beta'>]
    >()
    // @ts-expect-error multiple transports do not expose top-level send
    wata.send({ method: 'ping', params: [] })
  })

  test('returns a Host when given a host transport', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
    expectTypeOf(wata).toMatchTypeOf<{ start: () => Promise<void> }>()
    expectTypeOf(wata).toMatchTypeOf<{ on: Function }>()
  })

  test('accepts Schema imported from the host entrypoint', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema: hostSchema })
    wata.on('request', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping'>()
      event.respond({ ok: true })
      // @ts-expect-error wrong shape for ping
      event.respond('not the ping result')
    })
  })
})

describe('Consumer.send', () => {
  test('infers the result type from the schema entry', async () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })

    const ping = await wata.send({ method: 'ping', params: [] })
    expectTypeOf(ping.result).toEqualTypeOf<{ ok: true }>()

    const sig = await wata.send({ method: 'eth_sign', params: ['0x', '0x'] })
    expectTypeOf(sig.result).toEqualTypeOf<string>()
  })

  test('open schemas infer known methods and fall back for unknown methods', async () => {
    const { consumer } = loopback()
    const wata = Wata.create({ schema: open_schema, transports: [consumer] })

    const ping = await wata.send({ method: 'ping', params: [] })
    expectTypeOf(ping.result).toEqualTypeOf<{ ok: true }>()

    const fallback = await wata.send({ method: 'wallet_connect', params: [{ chains: [] }] })
    expectTypeOf(fallback.result).toEqualTypeOf<unknown>()

    // @ts-expect-error known methods still use their precise params
    wata.send({ method: 'ping', params: ['oops'] })
    // @ts-expect-error fallback params must be JSON-RPC params
    wata.send({ method: 'wallet_connect', params: null })
  })

  test('rejects unknown methods at compile time', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    // @ts-expect-error 'nope' is not in the schema
    wata.send({ method: 'nope', params: [] })
  })

  test('rejects wrong params shape at compile time', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    // @ts-expect-error params must be [number, number]-shaped per schema… or []
    wata.send({ method: 'ping', params: ['oops'] })
  })

  test('returns { id, result } shape (preserves JSON-RPC identity)', async () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    const out = await wata.send({ method: 'ping', params: [] })
    expectTypeOf(out.id).toEqualTypeOf<Rpc.Id>()
  })

  test('uses the default account/chain request context shape', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
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

  test('infers request context from the Wata context schema', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ context, transports: [consumer], schema })
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

  test('supports app-specific request context extensions', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ context: context_extended, transports: [consumer], schema })
    wata.send({
      context: { account: '0xabc', chainId: 1, origin: 'https://app.example' },
      method: 'ping',
      params: [],
    })
  })

  test('falls back to unknown when no schema is supplied', async () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer] })
    const out = await wata.send({ method: 'whatever', params: [] })
    expectTypeOf(out.result).toEqualTypeOf<unknown>()
  })
})

describe('Consumer.notify', () => {
  test('inherits the same method-name narrowing as send', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    wata.notify({ method: 'ping', params: [] })
    // @ts-expect-error 'nope' is not in the schema
    wata.notify({ method: 'nope', params: [] })
  })

  test('accepts unknown methods when the schema is open', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ schema: open_schema, transports: [consumer] })
    wata.notify({ method: 'wallet_connect', params: [] })
    // @ts-expect-error known methods still use their precise params
    wata.notify({ method: 'ping', params: ['oops'] })
  })
})

describe('Host.notify', () => {
  test('inherits the same method-name narrowing as send', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    wata.notify({ method: 'ping', params: [] })
    // @ts-expect-error 'nope' is not in the schema
    wata.notify({ method: 'nope', params: [] })
    // @ts-expect-error params must match the schema entry
    wata.notify({ method: 'eth_sign', params: ['0x'] })
  })

  test('accepts unknown methods when the schema is open', () => {
    const { host } = loopback()
    const wata = HostWata.create({ schema: open_schema, transports: [host] })
    wata.notify({ method: 'wallet_connect', params: [] })
    // @ts-expect-error known methods still use their precise params
    wata.notify({ method: 'ping', params: ['oops'] })
  })
})

describe('Host events', () => {
  test('`request` is a discriminated union over method (params + respond narrow together)', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    wata.on('request', (event) => {
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
    wata.on('request', () => ({ ok: true }))
  })

  test('`notification` payload is narrowed against the schema', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    wata.on('notification', (event) => {
      // @ts-expect-error loopback does not expose origin metadata
      expectTypeOf(event.meta.origin).toEqualTypeOf<never>()
      expectTypeOf(event.meta.transport).toEqualTypeOf<'loopback'>()
      expectTypeOf(event.method).toEqualTypeOf<'ping' | 'eth_sign'>()
      if (event.method === 'eth_sign')
        expectTypeOf(event.params).toMatchTypeOf<readonly [string, string]>()
    })
  })

  test('method-scoped listeners keep exact known-method types on open schemas', () => {
    const { host } = loopback()
    const wata = HostWata.create({ schema: open_schema, transports: [host] })

    wata.on('request', 'ping', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping'>()
      expectTypeOf(event.params).toMatchTypeOf<readonly []>()
      event.respond({ ok: true })
      // @ts-expect-error wrong shape for ping
      event.respond('not the ping result')
    })
    wata.on('request', 'ping', () => ({ ok: true as const }))
    wata.on('request', 'ping', async () => ({ ok: true as const }))
    // @ts-expect-error listener returns must match the method result
    wata.on('request', 'ping', () => 'not the ping result')
    // @ts-expect-error async listener returns must match the method result
    wata.on('request', 'ping', async () => 'not the ping result')
    wata.on('request', 'wallet_connect', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'wallet_connect'>()
      expectTypeOf(event.params).toMatchTypeOf<Rpc.Params>()
      event.respond({ opaque: true })
    })
    wata.on('request', 'wallet_connect', () => ({ opaque: true }))
  })

  test('method-scoped listeners reject unknown methods on closed schemas', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    // @ts-expect-error closed schemas only accept known request methods
    wata.on('request', 'wallet_connect', () => {})
  })

  test('`request` metadata narrows by transport', () => {
    const { host } = loopback()
    const wata = HostWata.create({
      schema,
      transports: [hostPostMessage({ target: () => popupHandle }), host],
    })
    wata.on('request', (event) => {
      expectTypeOf(event.meta.transport).toEqualTypeOf<'loopback' | 'postMessage'>()
      if (event.meta.transport === 'postMessage')
        expectTypeOf(event.meta.origin).toEqualTypeOf<string>()
      if (event.meta.transport === 'loopback') {
        // @ts-expect-error loopback does not expose origin metadata
        expectTypeOf(event.meta.origin).toEqualTypeOf<never>()
      }
    })
  })

  test('MessagePort postMessage metadata does not expose origin', () => {
    const wata = HostWata.create({
      schema,
      transports: [hostPostMessage({ target: () => portHandle })],
    })
    wata.on('request', (event) => {
      expectTypeOf(event.meta.transport).toEqualTypeOf<'postMessage'>()
      // @ts-expect-error MessagePort-backed postMessage does not expose origin metadata
      expectTypeOf(event.meta.origin).toEqualTypeOf<never>()
    })
  })

  test('`request` context is narrowed against the Wata context schema', () => {
    const { host } = loopback()
    const wata = HostWata.create({ context, transports: [host], schema })
    wata.on('request', (event) => {
      expectTypeOf(event.context).toEqualTypeOf<z.output<typeof context> | undefined>()
      expectTypeOf(event.request.context).toEqualTypeOf<z.output<typeof context> | undefined>()
      if (event.context) expectTypeOf(event.context.chainId).toEqualTypeOf<number>()
    })
  })

  test('lifecycle event payloads', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    wata.on('open', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<void>()
    })
    wata.on('close', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<Error | undefined>()
    })
    wata.on('error', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<Error>()
    })
    wata.on('rpc-requests', (requests, meta) => {
      expectTypeOf(requests).toEqualTypeOf<Wata.RpcRequestsPayload<typeof schema>>()
      expectTypeOf(meta).toEqualTypeOf<Wata.RpcEnvelopeMeta<'rpc-requests'>>()
    })
    wata.on('rpc-responses', (responses, meta) => {
      expectTypeOf(responses).toEqualTypeOf<Wata.RpcResponsesPayload<typeof schema>>()
      expectTypeOf(meta).toEqualTypeOf<Wata.RpcEnvelopeMeta<'rpc-responses'>>()
    })
  })

  test('rejects unknown event types at compile time', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    // @ts-expect-error 'nope' is not a known event
    wata.on('nope', () => {})
  })
})

describe('Consumer events', () => {
  test('exposes lifecycle, rpc, and notification events (no `request`)', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    wata.on('open', () => {})
    wata.on('close', () => {})
    wata.on('error', () => {})
    wata.on('notification', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping' | 'eth_sign'>()
      if (event.method === 'eth_sign')
        expectTypeOf(event.params).toMatchTypeOf<readonly [string, string]>()
    })
    wata.on('rpc-requests', (requests, meta) => {
      expectTypeOf(requests).toEqualTypeOf<Wata.RpcRequestsPayload<typeof schema>>()
      expectTypeOf(meta).toEqualTypeOf<Wata.RpcEnvelopeMeta<'rpc-requests'>>()
      expectTypeOf(meta.direction).toEqualTypeOf<'incoming' | 'outgoing'>()
      expectTypeOf(meta.transport).toEqualTypeOf<string>()
    })
    wata.on('rpc-responses', (responses, meta) => {
      expectTypeOf(responses).toEqualTypeOf<Wata.RpcResponsesPayload<typeof schema>>()
      expectTypeOf(meta).toEqualTypeOf<Wata.RpcEnvelopeMeta<'rpc-responses'>>()
      expectTypeOf(meta.direction).toEqualTypeOf<'incoming' | 'outgoing'>()
      expectTypeOf(meta.transport).toEqualTypeOf<string>()
    })
    // @ts-expect-error consumers don't receive `request`
    wata.on('request', () => {})
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
    const registration = await wata.webhookCallback.send({ method: 'ping', params: [] })
    expectTypeOf(registration).toEqualTypeOf<WebhookCallback.Registration>()
    const out = await wata.loopback.send({ method: 'ping', params: [] })
    expectTypeOf(out).toEqualTypeOf<Wata.SendResult<unknown>>()
  })
})

describe('on returns AbortController', () => {
  test('subscription returns an AbortController', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    const controller = wata.on('open', () => {})
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
