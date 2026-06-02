import { describe, expect, test } from 'vp/test'

import * as Uri from './Uri.js'

describe('normalizePath', () => {
  test('adds a leading slash when missing', () => {
    expect(Uri.normalizePath('callback')).toMatchInlineSnapshot(`"/callback"`)
  })

  test('leaves an existing leading slash untouched', () => {
    expect(Uri.normalizePath('/callback')).toMatchInlineSnapshot(`"/callback"`)
  })
})

describe('isAllowedAppCallback', () => {
  test('accepts https URLs', () => {
    expect(Uri.isAllowedAppCallback(new URL('https://app.example/callback'))).toMatchInlineSnapshot(
      `true`,
    )
  })

  test('accepts loopback http URLs', () => {
    expect(
      Uri.isAllowedAppCallback(new URL('http://127.0.0.1:3000/callback')),
    ).toMatchInlineSnapshot(`true`)
  })

  test('accepts reverse-DNS private-use URI schemes', () => {
    expect(Uri.isAllowedAppCallback(new URL('com.example.app:/callback'))).toMatchInlineSnapshot(
      `true`,
    )
  })

  test('rejects public http URLs', () => {
    expect(Uri.isAllowedAppCallback(new URL('http://app.example/callback'))).toMatchInlineSnapshot(
      `false`,
    )
  })

  test('rejects non-private URI schemes', () => {
    expect(Uri.isAllowedAppCallback(new URL('exampleapp:/callback'))).toMatchInlineSnapshot(
      `false`,
    )
  })
})

describe('isLoopbackHttp', () => {
  test('accepts localhost http URLs', () => {
    expect(Uri.isLoopbackHttp(new URL('http://localhost:3000/callback'))).toMatchInlineSnapshot(
      `true`,
    )
  })

  test('rejects public http URLs', () => {
    expect(Uri.isLoopbackHttp(new URL('http://app.example/callback'))).toMatchInlineSnapshot(
      `false`,
    )
  })
})

describe('matchesCallback', () => {
  test('accepts callbacks with matching base URI and registered query params', () => {
    expect(
      Uri.matchesCallback(
        new URL('com.example.app:/callback?nonce=1&state=abc'),
        'com.example.app:/callback?nonce=1',
      ),
    ).toMatchInlineSnapshot(`true`)
  })

  test('rejects callbacks with a different base URI', () => {
    expect(
      Uri.matchesCallback(
        new URL('com.example.app:/other?nonce=1'),
        'com.example.app:/callback?nonce=1',
      ),
    ).toMatchInlineSnapshot(`false`)
  })

  test('rejects callbacks missing registered query params', () => {
    expect(
      Uri.matchesCallback(new URL('com.example.app:/callback'), 'com.example.app:/callback?nonce=1'),
    ).toMatchInlineSnapshot(`false`)
  })
})

describe('requiredSearchParam', () => {
  test('returns a single non-empty query parameter', () => {
    expect(Uri.requiredSearchParam(new URL('https://app.example/cb?state=abc'), 'state'))
      .toMatchInlineSnapshot(`
        "abc"
      `)
  })

  test('rejects duplicate query parameters', () => {
    expect(Uri.requiredSearchParam(new URL('https://app.example/cb?state=abc&state=def'), 'state'))
      .toMatchInlineSnapshot(`
        undefined
      `)
  })

  test('rejects empty query parameters', () => {
    expect(Uri.requiredSearchParam(new URL('https://app.example/cb?state='), 'state'))
      .toMatchInlineSnapshot(`
        undefined
      `)
  })
})

describe('trimTrailingSlash', () => {
  test('removes one trailing slash', () => {
    expect(Uri.trimTrailingSlash('https://example.com/')).toMatchInlineSnapshot(
      `"https://example.com"`,
    )
  })

  test('leaves a value without a trailing slash untouched', () => {
    expect(Uri.trimTrailingSlash('https://example.com')).toMatchInlineSnapshot(
      `"https://example.com"`,
    )
  })
})
