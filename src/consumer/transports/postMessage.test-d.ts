import { describe, expectTypeOf, test } from 'vp/test'
import { Transport, postMessage } from 'wata'

declare const popupHandle: Window
declare const portHandle: MessagePort

describe('postMessage (consumer)', () => {
  test('returns a consumer-role transport', () => {
    const transport = postMessage({
      host: 'https://wallet.example',
      target: () => popupHandle,
    })
    expectTypeOf(transport).toEqualTypeOf<Transport.Transport<'consumer'>>()
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
  })

  test('host may be omitted or undefined', () => {
    postMessage({ target: () => portHandle })
    postMessage({ host: undefined, target: () => portHandle })
  })

  test('target callback receives { host }', () => {
    postMessage({
      host: 'https://wallet.example',
      target: ({ host }) => {
        expectTypeOf(host).toEqualTypeOf<string | undefined>()
        return popupHandle
      },
    })
  })

  test('target may return a Promise', () => {
    postMessage({
      host: 'https://wallet.example',
      target: async () => popupHandle,
    })
  })

  test('rejects neither-Window-nor-Port handles', () => {
    // @ts-expect-error 'string' is not a valid postMessage target
    postMessage({ host: 'https://wallet.example', target: () => 'nope' })
  })
})
