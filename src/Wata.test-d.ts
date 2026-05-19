import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery, Rpc, Schema, Transport, Wata, loopback } from 'wata'
import { Discovery as HostDiscovery, Schema as HostSchema, Wata as HostWata } from 'wata/host'
import { z } from 'zod/mini'

const privateKey = '0x' as Hex.Hex

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
  test('returns a Consumer when given a consumer transport', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(wata).toMatchTypeOf<{ start: () => Promise<void> }>()
    expectTypeOf(wata).toMatchTypeOf<{ send: Function }>()
    expectTypeOf(wata).toMatchTypeOf<{ notify: Function }>()
    expectTypeOf(wata.loopback).toMatchTypeOf<{ send: Function }>()
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
    expectTypeOf(wata.loopback).toEqualTypeOf<typeof host>()
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
})

describe('Host events', () => {
  test('`request` is a discriminated union over method (params + respond narrow together)', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    wata.on('request', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping' | 'eth_sign'>()
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
  })

  test('`notification` payload is narrowed against the schema', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    wata.on('notification', (event) => {
      expectTypeOf(event.method).toEqualTypeOf<'ping' | 'eth_sign'>()
      if (event.method === 'eth_sign')
        expectTypeOf(event.params).toMatchTypeOf<readonly [string, string]>()
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
  })

  test('rejects unknown event types at compile time', () => {
    const { host } = loopback()
    const wata = HostWata.create({ transports: [host], schema })
    // @ts-expect-error 'nope' is not a known event
    wata.on('nope', () => {})
  })
})

describe('Consumer events', () => {
  test('only exposes lifecycle events (no `request` / `notification`)', () => {
    const { consumer } = loopback()
    const wata = Wata.create({ transports: [consumer], schema })
    wata.on('open', () => {})
    wata.on('close', () => {})
    wata.on('error', () => {})
    // @ts-expect-error consumers don't receive `request`
    wata.on('request', () => {})
    // @ts-expect-error consumers don't receive `notification`
    wata.on('notification', () => {})
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

  test('consumer accepts `privateKey` as an Ed25519 private seed', () => {
    const { consumer } = loopback()
    Wata.create({ privateKey, transports: [consumer] })
  })

  test('host accepts `baseUrl` and `meta` typed as host Discovery.Meta', () => {
    const { host } = loopback()
    const meta: HostDiscovery.Meta = { name: 'Wallet' }
    HostWata.create({ baseUrl: 'https://wallet.example', meta, privateKey, transports: [host] })
  })

  test('host accepts `privateKey` as an Ed25519 private seed', () => {
    const { host } = loopback()
    HostWata.create({ privateKey, transports: [host] })
  })
})
