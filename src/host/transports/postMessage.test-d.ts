import { describe, expectTypeOf, test } from 'vp/test'
import { PostMessage, Transport, postMessage } from 'wata/host'

declare const popupHandle: Window
declare const portHandle: MessagePort

describe('postMessage (host)', () => {
  test('returns a host-role transport', () => {
    const transport = postMessage({
      target: () => popupHandle,
      targetOrigin: 'https://app.example',
    })
    expectTypeOf(transport).toEqualTypeOf<
      Transport.Transport<'host', 'postMessage', { meta: PostMessage.OriginMessageMeta }>
    >()
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
  })

  test('targetOrigin is optional (defaults to "*")', () => {
    postMessage({ target: () => popupHandle })
  })

  test('target is optional (defaults to window.opener / window.parent)', () => {
    postMessage()
    postMessage({ targetOrigin: 'https://app.example' })
  })

  test('MessagePort targets allow targetOrigin to be omitted', () => {
    const transport = postMessage({ target: () => portHandle })
    expectTypeOf(transport).toEqualTypeOf<
      Transport.Transport<'host', 'postMessage', { meta: Transport.NoMessageMeta }>
    >()
  })
})
