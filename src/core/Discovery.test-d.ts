import { Discovery } from 'handshakes'
import type { Hex } from 'ox'
import { describe, expectTypeOf, test } from 'vp/test'
import type { z } from 'zod'

describe('schema.hexPubkey', () => {
  test('infers `0x${string}` (= Hex.Hex)', () => {
    type Out = z.output<typeof Discovery.schema.hexPubkey>
    expectTypeOf<Out>().toEqualTypeOf<`0x${string}`>()
    expectTypeOf<Out>().toEqualTypeOf<Hex.Hex>()
  })
})

describe('schema.httpsUrl', () => {
  test('infers string (Zod URL output is a normalized string)', () => {
    type Out = z.output<typeof Discovery.schema.httpsUrl>
    expectTypeOf<Out>().toEqualTypeOf<string>()
  })
})

describe('HostDocument', () => {
  test('identity_pubkey is hex; optional fields are `T | undefined`', () => {
    expectTypeOf<Discovery.HostDocument['identity_pubkey']>().toEqualTypeOf<Hex.Hex>()
    expectTypeOf<Discovery.HostDocument['relay_url']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.HostDocument['deep_link_url']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.HostDocument['callback_urls']>().toEqualTypeOf<string[] | undefined>()
  })
})

describe('ConsumerDocument', () => {
  test('identity_pubkey is hex; callback_urls optional', () => {
    expectTypeOf<Discovery.ConsumerDocument['identity_pubkey']>().toEqualTypeOf<Hex.Hex>()
    expectTypeOf<Discovery.ConsumerDocument['callback_urls']>().toEqualTypeOf<
      string[] | undefined
    >()
  })
})
