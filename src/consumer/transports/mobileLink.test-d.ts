import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery, MobileLink, Transport, Wata, mobileLink } from 'wata'

describe('mobileLink (consumer)', () => {
  test('returns an ongoing consumer-role transport with a URL handler', () => {
    const transport = mobileLink({
      callbackUrl: 'exampleapp://callback',
      identity: {
        deepLinkUrl: 'examplewallet://auth',
        publicKey: '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc',
      },
    })
    expectTypeOf(transport.role).toEqualTypeOf<'consumer'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'consumer'>>()
    expectTypeOf(transport.handle).toEqualTypeOf<(url: string | URL) => Promise<void>>()
  })

  test('feeds Wata.create as a consumer transport', () => {
    const wata = Wata.create({
      transports: [
        mobileLink({
          callbackUrl: 'exampleapp://callback',
          identity: {
            deepLinkUrl: 'examplewallet://auth',
            publicKey: '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc',
          },
        }),
      ],
    })
    expectTypeOf(wata.role).toEqualTypeOf<'consumer'>()
  })

  test('accepts discovery mode with string or pre-parsed host document', () => {
    const document: Discovery.HostDocument = {
      id: 'wallet.example',
      identity_pubkey: '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc',
      name: 'Example Wallet',
      origin: 'https://wallet.example',
      transports: {
        'mobile-link': {
          scheme: 'examplewallet',
          universal_link: 'https://wallet.example/auth/mobile-link',
        },
      },
      version: '1.0',
    }

    mobileLink({
      callbackUrl: 'exampleapp://callback',
      host: 'https://wallet.example',
    })
    mobileLink({
      callbackUrl: 'exampleapp://callback',
      host: document,
    })
  })

  test('accepts pinned identity mode', () => {
    expectTypeOf<MobileLink.Options>().toMatchTypeOf<
      | {
          callbackUrl: string
          host: string | Discovery.HostDocument
          open?: ((url: string) => unknown) | undefined
        }
      | {
          callbackUrl: string
          identity: { deepLinkUrl: string; publicKey: string }
          open?: ((url: string) => unknown) | undefined
        }
    >()
  })
})
