import { describe, expect, test } from 'vp/test'

import { postMessage } from './postMessage.js'

describe('postMessage', () => {
  test('publishes a `window` discovery binding defaulting to baseUrl', () => {
    const transport = postMessage()
    expect(transport.discovery?.id).toBe('window')
    expect(transport.discovery?.binding('https://wallet.example')).toMatchInlineSnapshot(`
      {
        "url": "https://wallet.example",
      }
    `)
  })

  test('resolves a relative `url` against baseUrl', () => {
    const transport = postMessage({ url: '/host.html' })
    expect(transport.discovery?.binding('https://wallet.example/')).toMatchInlineSnapshot(`
      {
        "url": "https://wallet.example/host.html",
      }
    `)
  })

  test('passes through an absolute `url`', () => {
    const transport = postMessage({ url: 'https://host.example/page.html' })
    expect(transport.discovery?.binding('https://wallet.example')).toMatchInlineSnapshot(`
      {
        "url": "https://host.example/page.html",
      }
    `)
  })
})
