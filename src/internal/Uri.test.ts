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
