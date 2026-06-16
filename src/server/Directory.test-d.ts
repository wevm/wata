import { describe, expectTypeOf, test } from 'vp/test'

import * as Directory from './Directory.js'

describe('Item', () => {
  test('is the camelCased parsed row', () => {
    expectTypeOf<Directory.Item>().toEqualTypeOf<{
      capabilities?: readonly string[] | undefined
      icon?: string | undefined
      id: string
      name: string
      origin: string
      wellKnownUrl: string
    }>()
  })
})

describe('WireItem', () => {
  test('uses the snake_case well_known_url', () => {
    expectTypeOf<Directory.WireItem>().toMatchTypeOf<{
      id: string
      name: string
      origin: string
      well_known_url: string
    }>()
  })
})

describe('QueryResult', () => {
  test('carries camelCased items and a nullable cursor', () => {
    expectTypeOf<Directory.QueryResult['items']>().toEqualTypeOf<Directory.Item[]>()
    expectTypeOf<Directory.QueryResult['cursor']>().toEqualTypeOf<string | null | undefined>()
  })
})
