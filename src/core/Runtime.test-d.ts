import { describe, expectTypeOf, test } from 'vp/test'
import { Runtime, Schema, Transport, loopback } from 'wata/core'
import { z } from 'zod/mini'

const schema = Schema.create({
  methods: {
    ping: Schema.method({
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
  test('returns a typed consumer runtime without fetch', () => {
    const { consumer } = loopback()
    const runtime = Runtime.create({ transports: [consumer], schema })

    expectTypeOf(runtime.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(runtime).toMatchTypeOf<{ send: Function }>()
    expectTypeOf(runtime).not.toHaveProperty('fetch')
  })

  test('returns named child sessions for multiple consumer transports', () => {
    const alpha = namedPair('alpha')
    const beta = namedPair('beta')
    const runtime = Runtime.create({ transports: [alpha.consumer, beta.consumer], schema })

    expectTypeOf(runtime.alpha).toMatchTypeOf<{ send: Function }>()
    expectTypeOf(runtime.beta).toMatchTypeOf<{ send: Function }>()
    // @ts-expect-error multiple transports do not expose top-level send
    runtime.send({ method: 'ping', params: [] })
  })

  test('returns a typed host runtime without fetch', () => {
    const { host } = loopback()
    const runtime = Runtime.create({ transports: [host], schema })

    expectTypeOf(runtime.role).toEqualTypeOf<'host'>()
    expectTypeOf(runtime).toMatchTypeOf<{ on: Function }>()
    expectTypeOf(runtime).not.toHaveProperty('fetch')
  })
})
