import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery, MobileWebAuth, Transport, Wata, mobileWebAuth } from 'wata'

describe('mobileWebAuth (consumer)', () => {
  test('returns a single-exchange consumer transport with a callback handler', () => {
    const transport = mobileWebAuth({
      callbackUrl: 'com.example.app://callback',
      host: 'https://wallet.example',
      id: 'https://app.example',
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
    expectTypeOf(transport.handle).toEqualTypeOf<(url: string | URL) => Promise<void>>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const wata = Wata.create({
      baseUrl: 'https://app.example',
      meta: { name: 'Example App' },
      transports: [
        mobileWebAuth({
          callbackUrl: 'com.example.app://callback',
          host: 'https://wallet.example',
        }),
      ],
    })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(wata.mobileWebAuth.handle).toEqualTypeOf<(url: string | URL) => Promise<void>>()
  })

  test('accepts discovery mode with string or pre-parsed host document', () => {
    const document: Discovery.HostDocument = {
      id: 'wallet.example',
      identity_pubkey: '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc',
      name: 'Example Wallet',
      origin: 'https://wallet.example',
      transports: {
        'mobile-web-auth': {
          auth_url: 'https://wallet.example/auth/mobile',
        },
      },
      version: '1.0',
    }

    mobileWebAuth({
      callbackUrl: 'com.example.app://callback',
      host: 'https://wallet.example',
      id: 'https://app.example',
    })
    mobileWebAuth({
      callbackUrl: 'com.example.app://callback',
      host: document,
      id: 'https://app.example',
    })
  })

  test('options expose callbackUrl, host, id, open, and fetch', () => {
    expectTypeOf<MobileWebAuth.Options>().toMatchTypeOf<{
      callbackUrl: string
      fetch?: typeof fetch | undefined
      host: string | Discovery.HostDocument
      id?: string | undefined
      open?: ((url: string) => unknown) | undefined
    }>()
  })
})
