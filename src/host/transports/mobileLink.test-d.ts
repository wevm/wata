import { describe, expectTypeOf, test } from 'vp/test'
import { Transport } from 'wata'
import { Wata, mobileLink } from 'wata/host'

describe('mobileLink (host)', () => {
  test('returns an ongoing host-role transport with handleUrl', () => {
    const transport = mobileLink({ openLink: () => {}, scheme: 'examplewallet' })
    expectTypeOf(transport.role).toEqualTypeOf<'host'>()
    expectTypeOf(transport.exchange).toEqualTypeOf<Transport.Exchange>()
    expectTypeOf(transport.handleUrl).toEqualTypeOf<(url: string) => Promise<void>>()
    expectTypeOf(transport).toMatchTypeOf<Transport.Transport<'host', 'mobileLink'>>()
  })

  test('feeds Wata.create as a host transport', () => {
    const transport = mobileLink({ openLink: () => {}, scheme: 'examplewallet' })
    const wata = Wata.create({ transports: [transport] })
    const session = wata.mobileLink.start()
    expectTypeOf(wata.role).toEqualTypeOf<'host'>()
    expectTypeOf(wata.mobileLink).toEqualTypeOf<Pick<typeof wata.mobileLink, 'start'>>()
    // handleUrl lives on the started session, not the handle.
    expectTypeOf(wata.mobileLink).not.toHaveProperty('handleUrl')
    expectTypeOf(session.handleUrl).toEqualTypeOf<(url: string) => Promise<void>>()
    expectTypeOf(session.transport.handleUrl).toEqualTypeOf<(url: string) => Promise<void>>()
  })
})
