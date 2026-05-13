import { Transport, postMessage } from 'handshakes/host'
import { describe, expectTypeOf, test } from 'vp/test'

declare const popupHandle: Window
declare const portHandle: MessagePort

describe('postMessage (host)', () => {
  test('returns a host-role transport', () => {
    const transport = postMessage({
      open: () => popupHandle,
      targetOrigin: 'https://app.example',
    })
    expectTypeOf(transport).toEqualTypeOf<Transport.Transport<'host'>>()
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
  })

  test('Window targets require targetOrigin', () => {
    // @ts-expect-error `targetOrigin` is required for Window targets
    postMessage({ open: () => popupHandle })
  })

  test('MessagePort targets allow targetOrigin to be omitted', () => {
    postMessage({ open: () => portHandle })
  })
})
