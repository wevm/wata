import { describe, expectTypeOf, test } from 'vp/test'
import { Discovery } from 'wata'
import type { z } from 'zod/mini'

describe('schema.identityPubkey', () => {
  test('infers a plain string (unpadded base64url Ed25519, 43 chars)', () => {
    type Out = z.output<typeof Discovery.schema.identityPubkey>
    expectTypeOf<Out>().toEqualTypeOf<string>()
  })
})

describe('schema.httpsUrl', () => {
  test('infers string (Zod URL output is a normalized string)', () => {
    type Out = z.output<typeof Discovery.schema.httpsUrl>
    expectTypeOf<Out>().toEqualTypeOf<string>()
  })
})

describe('HostDocument', () => {
  test('shared header + identity_pubkey types', () => {
    expectTypeOf<Discovery.HostDocument['version']>().toEqualTypeOf<'1.0'>()
    expectTypeOf<Discovery.HostDocument['origin']>().toEqualTypeOf<string>()
    expectTypeOf<Discovery.HostDocument['id']>().toEqualTypeOf<string>()
    expectTypeOf<Discovery.HostDocument['name']>().toEqualTypeOf<string>()
    expectTypeOf<Discovery.HostDocument['icon']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.HostDocument['description']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.HostDocument['website_url']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.HostDocument['capabilities']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<Discovery.HostDocument['identity_pubkey']>().toEqualTypeOf<string>()
    expectTypeOf<Discovery.HostDocument>().not.toHaveProperty('meta')
  })

  test('transports map carries per-binding optional shapes', () => {
    type Transports = Discovery.HostDocument['transports']
    expectTypeOf<Transports['relay']>().toEqualTypeOf<{ url: string } | undefined>()
    expectTypeOf<Transports['window']>().toEqualTypeOf<{ url: string } | undefined>()
    expectTypeOf<Transports['mobile-link']>().toEqualTypeOf<
      { scheme: string; universal_link: string } | undefined
    >()
    expectTypeOf<Transports['device-code']>().toEqualTypeOf<
      { register_url: string; token_url: string } | undefined
    >()
  })
})

describe('ConsumerDocument', () => {
  test('shared header + callback_urls; no identity_pubkey', () => {
    expectTypeOf<Discovery.ConsumerDocument['version']>().toEqualTypeOf<'1.0'>()
    expectTypeOf<Discovery.ConsumerDocument['origin']>().toEqualTypeOf<string>()
    expectTypeOf<Discovery.ConsumerDocument['id']>().toEqualTypeOf<string>()
    expectTypeOf<Discovery.ConsumerDocument['callback_urls']>().toEqualTypeOf<
      string[] | undefined
    >()
    expectTypeOf<Discovery.ConsumerDocument['name']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.ConsumerDocument['icon']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.ConsumerDocument['description']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.ConsumerDocument['website_url']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.ConsumerDocument>().not.toHaveProperty('meta')
    expectTypeOf<Discovery.ConsumerDocument>().not.toHaveProperty('identity_pubkey')
  })
})

describe('Meta', () => {
  test('shape', () => {
    expectTypeOf<Discovery.Meta['name']>().toEqualTypeOf<string>()
    expectTypeOf<Discovery.Meta['icon']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.Meta['description']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Discovery.Meta['website_url']>().toEqualTypeOf<string | undefined>()
  })
})
