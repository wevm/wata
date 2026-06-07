import { describe, expect, test } from 'vp/test'

import * as Events from './Events.js'

describe('create', () => {
  test('emits single and tuple payloads', () => {
    const emitter = Events.create<{
      message: { id: string }
      pair: [string, number]
    }>()
    const seen: unknown[] = []

    emitter.on('message', (payload) => seen.push(payload))
    emitter.on('pair', (left, right) => seen.push([left, right]))

    expect({
      message: emitter.emit('message', { id: '1' }),
      pair: emitter.emit('pair', 'left', 2),
      seen,
    }).toMatchInlineSnapshot(`
      {
        "message": true,
        "pair": true,
        "seen": [
          {
            "id": "1",
          },
          [
            "left",
            2,
          ],
        ],
      }
    `)
  })

  test('removes listeners by reference', () => {
    const emitter = Events.create<{ message: string }>()
    const seen: string[] = []
    const listener = (payload: string) => seen.push(payload)

    emitter.on('message', listener)
    emitter.off('message', listener)

    expect({
      emitted: emitter.emit('message', 'ignored'),
      listenerCount: emitter.listenerCount('message'),
      seen,
    }).toMatchInlineSnapshot(`
      {
        "emitted": false,
        "listenerCount": 0,
        "seen": [],
      }
    `)
  })

  test('removes listeners when their signal aborts', () => {
    const emitter = Events.create<{ message: string }>()
    const controller = new AbortController()
    const seen: string[] = []

    emitter.on('message', (payload) => seen.push(payload), { signal: controller.signal })
    controller.abort()

    expect({
      emitted: emitter.emit('message', 'ignored'),
      listenerCount: emitter.listenerCount('message'),
      seen,
    }).toMatchInlineSnapshot(`
      {
        "emitted": false,
        "listenerCount": 0,
        "seen": [],
      }
    `)
  })

  test('swallows listener errors and continues dispatching', () => {
    const emitter = Events.create<{ message: string }>()
    const seen: string[] = []

    emitter.on('message', () => {
      throw new Error('boom')
    })
    emitter.on('message', (payload) => seen.push(payload))

    expect({
      emitted: emitter.emit('message', 'ok'),
      listenerCount: emitter.listenerCount(),
      seen,
    }).toMatchInlineSnapshot(`
      {
        "emitted": true,
        "listenerCount": 2,
        "seen": [
          "ok",
        ],
      }
    `)
  })
})
