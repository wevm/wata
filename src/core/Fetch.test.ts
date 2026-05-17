import { describe, expect, test } from 'vp/test'

import * as Fetch from './Fetch.js'

describe('withTimeout', () => {
  test('passes input + init through to the wrapped fetch', async () => {
    const calls: Array<{ init: RequestInit | undefined; input: unknown }> = []
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ init, input })
      return new Response('ok', { status: 200 })
    }
    const fetch = Fetch.withTimeout(fakeFetch, 1000)
    const response = await fetch('https://example.com', {
      body: '{"a":1}',
      method: 'POST',
    })
    expect(response.status).toBe(200)
    expect(calls[0]?.input).toBe('https://example.com')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('aborts the wrapped fetch when the timeout elapses', async () => {
    const fakeFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const fetch = Fetch.withTimeout(fakeFetch, 10)
    await expect(fetch('https://example.com')).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: aborted]`,
    )
  })

  test('composes caller-supplied `init.signal` with the timeout signal', async () => {
    const callerController = new AbortController()
    const fakeFetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const fetch = Fetch.withTimeout(fakeFetch, 1000)
    const promise = fetch('https://example.com', { signal: callerController.signal })
    queueMicrotask(() => callerController.abort())
    await expect(promise).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: aborted]`)
  })

  test('clears the timer on success so a slow event loop does not abort the next call', async () => {
    let callCount = 0
    const fakeFetch: typeof globalThis.fetch = async () => {
      callCount += 1
      return new Response('ok')
    }
    const fetch = Fetch.withTimeout(fakeFetch, 50)
    await fetch('https://example.com')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await fetch('https://example.com')
    expect(callCount).toBe(2)
  })
})
