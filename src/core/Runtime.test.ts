import { describe, expect, test } from 'vp/test'
import { Runtime, loopback } from 'wata/core'

describe('create', () => {
  test('creates consumer and host runtimes without HTTP handlers', async () => {
    const { consumer: consumerTransport, host: hostTransport } = loopback()
    const consumer = Runtime.create({ transports: [consumerTransport] })
    const host = Runtime.create({ transports: [hostTransport] })

    host.on('request', 'ping', () => ({ ok: true }))

    await expect(consumer.send({ method: 'ping', params: [] })).resolves.toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "ok": true,
        },
      }
    `)
    expect('fetch' in consumer).toMatchInlineSnapshot(`false`)
    expect('fetch' in host).toMatchInlineSnapshot(`false`)
  })
})
