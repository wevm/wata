import { describe, expectTypeOf, test } from 'vp/test'
import { PostMessage, Transport, postMessage } from 'wata'

declare const popupHandle: Window
declare const portHandle: MessagePort

describe('postMessage (consumer)', () => {
  test('returns a consumer-role transport', () => {
    const transport = postMessage({
      host: 'https://wallet.example',
      target: () => popupHandle,
    })
    expectTypeOf(transport).toEqualTypeOf<
      Transport.Transport<
        'consumer',
        'postMessage',
        { meta: PostMessage.OriginMessageMeta; startOptions: PostMessage.StartOptions<Window> }
      >
    >()
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
  })

  test('host may be omitted or undefined', () => {
    expectTypeOf(postMessage({ target: () => portHandle })).toEqualTypeOf<
      Transport.Transport<
        'consumer',
        'postMessage',
        { meta: Transport.NoMessageMeta; startOptions: PostMessage.StartOptions<MessagePort> }
      >
    >()
    expectTypeOf(postMessage({ host: undefined, target: () => portHandle })).toEqualTypeOf<
      Transport.Transport<
        'consumer',
        'postMessage',
        { meta: Transport.NoMessageMeta; startOptions: PostMessage.StartOptions<MessagePort> }
      >
    >()
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

  test('`target` may be deferred to `start` (no-arg construction compiles)', () => {
    expectTypeOf(postMessage()).toMatchTypeOf<{ role: 'consumer'; name: 'postMessage' }>()
    // `start` accepts the deferred `target` (plus `close` / `host`).
    postMessage().start({ target: () => popupHandle })
  })

  test('`StartOptions` is the deferrable subset (`close`, `host`, `target`)', () => {
    expectTypeOf<PostMessage.StartOptions<Window>>().toEqualTypeOf<{
      close?: ((handle: Window) => void | Promise<void>) | undefined
      host?: string | undefined
      target?: ((parameters: { host: string | undefined }) => Window | Promise<Window>) | undefined
    }>()
  })
})
