import { Transport, postMessage } from 'handshakes'
import { describe, expectTypeOf, test } from 'vp/test'

declare const popupHandle: Window
declare const portHandle: MessagePort

describe('postMessage (consumer)', () => {
  test('returns a consumer-role transport', () => {
    const transport = postMessage({
      open: () => popupHandle,
      targetOrigin: 'https://wallet.example',
    })
    expectTypeOf(transport).toEqualTypeOf<Transport.Transport<'consumer'>>()
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
  })

  test('Window/WindowProxy targets require targetOrigin', () => {
    // @ts-expect-error `targetOrigin` is required for Window targets
    postMessage({ open: () => popupHandle })
  })

  test('MessagePort targets allow targetOrigin to be omitted or undefined', () => {
    postMessage({ open: () => portHandle })
    postMessage({ open: () => portHandle, targetOrigin: undefined })
  })

  test('open may return a Promise', () => {
    postMessage({
      open: async () => popupHandle,
      targetOrigin: 'https://wallet.example',
    })
  })

  test('rejects neither-Window-nor-Port handles', () => {
    // @ts-expect-error 'string' is not a valid postMessage target
    postMessage({ open: () => 'nope', targetOrigin: 'https://wallet.example' })
  })
})
