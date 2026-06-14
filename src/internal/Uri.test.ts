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
  test('validates callback URI schemes', () => {
    expect(
      [
        'https://app.example/callback',
        'http://127.0.0.1:3000/callback',
        'com.example.app:/callback',
        'http://app.example/callback',
        'exampleapp:/callback',
      ].map((value) => [value, Uri.isAllowedAppCallback(new URL(value))]),
    ).toMatchInlineSnapshot(`
      [
        [
          "https://app.example/callback",
          true,
        ],
        [
          "http://127.0.0.1:3000/callback",
          true,
        ],
        [
          "com.example.app:/callback",
          true,
        ],
        [
          "http://app.example/callback",
          false,
        ],
        [
          "exampleapp:/callback",
          false,
        ],
      ]
    `)
  })
})

describe('isLoopbackHttp', () => {
  test('validates loopback http URLs', () => {
    expect(
      ['http://localhost:3000/callback', 'http://app.example/callback'].map((value) => [
        value,
        Uri.isLoopbackHttp(new URL(value)),
      ]),
    ).toMatchInlineSnapshot(`
      [
        [
          "http://localhost:3000/callback",
          true,
        ],
        [
          "http://app.example/callback",
          false,
        ],
      ]
    `)
  })
})

describe('isPrivateHttp', () => {
  test('validates private-network http URLs', () => {
    expect(
      [
        'http://10.0.2.2:4860',
        'http://172.20.10.2:4860',
        'http://192.168.1.20:4860',
        'http://169.254.10.10:4860',
        'http://my-laptop.local:4860',
        'http://relay.example',
        'http://8.8.8.8',
        'https://192.168.1.20',
      ].map((value) => [value, Uri.isPrivateHttp(new URL(value))]),
    ).toMatchInlineSnapshot(`
      [
        [
          "http://10.0.2.2:4860",
          true,
        ],
        [
          "http://172.20.10.2:4860",
          true,
        ],
        [
          "http://192.168.1.20:4860",
          true,
        ],
        [
          "http://169.254.10.10:4860",
          true,
        ],
        [
          "http://my-laptop.local:4860",
          true,
        ],
        [
          "http://relay.example",
          false,
        ],
        [
          "http://8.8.8.8",
          false,
        ],
        [
          "https://192.168.1.20",
          false,
        ],
      ]
    `)
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
      Uri.matchesCallback(
        new URL('com.example.app:/callback'),
        'com.example.app:/callback?nonce=1',
      ),
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
