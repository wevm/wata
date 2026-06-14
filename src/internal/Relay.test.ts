import { describe, expect, test } from 'vp/test'
import { Crypto, Envelope, Session } from 'wata'

import * as Relay from './Relay.js'

const consumerPublicKey =
  '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' as const
const hostPublicKey = '0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100' as const
const pairingSecret = '0x0101010101010101010101010101010101010101010101010101010101010101' as const
const sharedSecret = '0x0202020202020202020202020202020202020202020202020202020202020202' as const

describe('channelId', () => {
  test('derives a 43-character unpadded base64url identifier', () => {
    const id = Relay.channelId({ consumerPublicKey, pairingSecret })
    expect(id).toMatchInlineSnapshot(`"QuKIGwZby7IhF3j8VAF6gFlxCL2_Vt1h9_IPNkbCyzg"`)
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('changes when the pairing secret changes', () => {
    const other = Relay.channelId({
      consumerPublicKey,
      pairingSecret: '0x0303030303030303030303030303030303030303030303030303030303030303',
    })
    expect(other).not.toBe(Relay.channelId({ consumerPublicKey, pairingSecret }))
  })

  test('rejects a consumerPublicKey that is not 32 bytes', () => {
    expect(() =>
      Relay.channelId({ consumerPublicKey: '0xdead', pairingSecret }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: consumerPublicKey must be 32 bytes
      Details: received 2 bytes]
    `,
    )
  })

  test('rejects a pairingSecret that is not 32 bytes', () => {
    expect(() =>
      Relay.channelId({ consumerPublicKey, pairingSecret: '0xdead' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: pairingSecret must be 32 bytes
      Details: received 2 bytes]
    `,
    )
  })
})

describe('hostProof', () => {
  test('computes the spec HMAC binding', () => {
    expect(
      Relay.hostProof({ consumerPublicKey, hostPublicKey, pairingSecret, sharedSecret }),
    ).toMatchInlineSnapshot(`"0xaa6f7dc3eb6172cbdfb17a09ac86e2c0280be7d0e6141bb47d78d849160ab637"`)
  })

  test('changes when any input changes', () => {
    const proof = Relay.hostProof({ consumerPublicKey, hostPublicKey, pairingSecret, sharedSecret })
    expect(
      Relay.hostProof({
        consumerPublicKey,
        hostPublicKey,
        pairingSecret,
        sharedSecret: '0x0303030303030303030303030303030303030303030303030303030303030303',
      }),
    ).not.toBe(proof)
    expect(
      Relay.hostProof({
        consumerPublicKey,
        hostPublicKey: consumerPublicKey,
        pairingSecret,
        sharedSecret,
      }),
    ).not.toBe(proof)
  })
})

describe('decodeSecret', () => {
  test('round-trips with encodeSecret', () => {
    expect(Relay.decodeSecret(Relay.encodeSecret(pairingSecret))).toBe(pairingSecret)
  })

  test('rejects malformed values', () => {
    expect(() => Relay.decodeSecret('not-base64url')).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: pairing secret must be 32-byte unpadded base64url]',
    )
    expect(() => Relay.decodeSecret('A'.repeat(44))).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: pairing secret must be 32-byte unpadded base64url]',
    )
  })
})

describe('encodeSecret', () => {
  test('encodes 32 bytes as 43 base64url characters', () => {
    expect(Relay.encodeSecret(pairingSecret)).toMatchInlineSnapshot(
      `"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"`,
    )
  })

  test('rejects a secret that is not 32 bytes', () => {
    expect(() => Relay.encodeSecret('0xdead')).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: pairing secret must be 32 bytes]',
    )
  })
})

describe('buildUri', () => {
  test('builds a shared-scheme link by default', () => {
    expect(
      Relay.buildUri({ consumerPublicKey, pairingSecret, relay: 'https://relay.example' }),
    ).toMatchInlineSnapshot(
      `"urpc://?consumer_pubkey=ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8&pairing_secret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&relay=https%3A%2F%2Frelay.example&version=1"`,
    )
  })

  test('builds a universal link when `host` is set', () => {
    expect(
      Relay.buildUri({
        consumerPublicKey,
        host: 'https://wallet.example/urpc',
        pairingSecret,
        relay: 'https://relay.example',
      }),
    ).toMatchInlineSnapshot(
      `"https://wallet.example/urpc?consumer_pubkey=ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8&pairing_secret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&relay=https%3A%2F%2Frelay.example&version=1"`,
    )
  })

  test('preserves existing query parameters on `host`', () => {
    const uri = Relay.buildUri({
      consumerPublicKey,
      host: 'https://wallet.example/urpc?theme=dark',
      pairingSecret,
      relay: 'https://relay.example',
    })
    expect(new URL(uri).searchParams.get('theme')).toBe('dark')
  })

  test('allows an HTTP loopback relay for development', () => {
    const uri = Relay.buildUri({ consumerPublicKey, pairingSecret, relay: 'http://localhost:8787' })
    expect(new URL(uri).searchParams.get('relay')).toBe('http://localhost:8787')
  })

  test('allows an HTTP private-network relay with `allowPrivateNetwork`', () => {
    const uri = Relay.buildUri({
      allowPrivateNetwork: true,
      consumerPublicKey,
      pairingSecret,
      relay: 'http://192.168.1.20:4860',
    })
    expect(new URL(uri).searchParams.get('relay')).toBe('http://192.168.1.20:4860')
  })

  test('rejects an HTTP private-network relay without `allowPrivateNetwork`', () => {
    expect(() =>
      Relay.buildUri({ consumerPublicKey, pairingSecret, relay: 'http://192.168.1.20:4860' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must be an HTTPS URL (or HTTP loopback; pass \`allowPrivateNetwork\` for LAN development)
      Details: received http://192.168.1.20:4860]
    `,
    )
  })

  test('rejects a non-HTTPS relay', () => {
    expect(() =>
      Relay.buildUri({ consumerPublicKey, pairingSecret, relay: 'http://relay.example' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must be an HTTPS URL (or HTTP loopback; pass \`allowPrivateNetwork\` for LAN development)
      Details: received http://relay.example]
    `,
    )
  })

  test('rejects a relay URL with a query or fragment', () => {
    expect(() =>
      Relay.buildUri({
        consumerPublicKey,
        pairingSecret,
        relay: 'https://relay.example/api?foo=bar',
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must not contain a query or fragment
      Details: received https://relay.example/api?foo=bar]
    `,
    )
    expect(() =>
      Relay.buildUri({ consumerPublicKey, pairingSecret, relay: 'https://relay.example/#x' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must not contain a query or fragment
      Details: received https://relay.example/#x]
    `,
    )
  })

  test('rejects an invalid `host`', () => {
    expect(() =>
      Relay.buildUri({
        consumerPublicKey,
        host: '::',
        pairingSecret,
        relay: 'https://relay.example',
      }),
    ).toThrowErrorMatchingInlineSnapshot('[ProtocolError: `host` must be a valid URL]')
  })
})

describe('parseUri', () => {
  test('round-trips a shared-scheme link', () => {
    const uri = Relay.buildUri({ consumerPublicKey, pairingSecret, relay: 'https://relay.example' })
    expect(Relay.parseUri(uri)).toMatchInlineSnapshot(`
      {
        "consumerPublicKey": "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        "pairingSecret": "0x0101010101010101010101010101010101010101010101010101010101010101",
        "relay": "https://relay.example",
        "version": 1,
      }
    `)
  })

  test('round-trips a universal link', () => {
    const uri = Relay.buildUri({
      consumerPublicKey,
      host: 'https://wallet.example/urpc',
      pairingSecret,
      relay: 'https://relay.example',
    })
    expect(Relay.parseUri(uri)).toEqual(
      Relay.parseUri(
        Relay.buildUri({ consumerPublicKey, pairingSecret, relay: 'https://relay.example' }),
      ),
    )
  })

  test('rejects a malformed uri', () => {
    expect(() => Relay.parseUri('::')).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: pairing uri is not a valid URL]',
    )
  })

  test('rejects a missing version', () => {
    expect(() =>
      Relay.parseUri('urpc://?consumer_pubkey=x&pairing_secret=y&relay=z'),
    ).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: pairing uri is missing a `version` parameter]',
    )
  })

  test('rejects an unsupported version', () => {
    const uri = Relay.buildUri({
      consumerPublicKey,
      pairingSecret,
      relay: 'https://relay.example',
    }).replace('version=1', 'version=2')
    expect(() => Relay.parseUri(uri)).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: pairing uri has an unsupported \`version\`
      Details: received 2, supported 1]
    `,
    )
  })

  test('rejects a duplicated parameter', () => {
    const uri = `${Relay.buildUri({
      consumerPublicKey,
      pairingSecret,
      relay: 'https://relay.example',
    })}&version=1`
    expect(() => Relay.parseUri(uri)).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: pairing uri is missing a `version` parameter]',
    )
  })

  test('rejects a malformed consumer_pubkey', () => {
    const uri = Relay.buildUri({
      consumerPublicKey,
      pairingSecret,
      relay: 'https://relay.example',
    }).replace(/consumer_pubkey=[^&]+/, 'consumer_pubkey=nope')
    expect(() => Relay.parseUri(uri)).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: public key must be 32-byte unpadded base64url]',
    )
  })

  test('rejects a non-HTTPS relay', () => {
    const uri = Relay.buildUri({
      consumerPublicKey,
      pairingSecret,
      relay: 'https://relay.example',
    }).replace('relay=https%3A%2F%2Frelay.example', 'relay=http%3A%2F%2Frelay.example')
    expect(() => Relay.parseUri(uri)).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must be an HTTPS URL (or HTTP loopback; pass \`allowPrivateNetwork\` for LAN development)
      Details: received http://relay.example]
    `,
    )
  })

  test('rejects a private-network relay by default but accepts it with `allowPrivateNetwork`', () => {
    const uri = Relay.buildUri({
      allowPrivateNetwork: true,
      consumerPublicKey,
      pairingSecret,
      relay: 'http://169.254.169.254',
    })
    // A malicious pairing link pointing the host at the cloud metadata
    // endpoint must fail closed unless the host explicitly opts in.
    expect(() => Relay.parseUri(uri)).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: relay must be an HTTPS URL (or HTTP loopback; pass \`allowPrivateNetwork\` for LAN development)
      Details: received http://169.254.169.254]
    `,
    )
    expect(Relay.parseUri(uri, { allowPrivateNetwork: true }).relay).toBe('http://169.254.169.254')
  })
})

describe('createCipher', () => {
  function pair() {
    const consumer = Crypto.randomKeypair()
    const host = Crypto.randomKeypair()
    const keys_consumer = Session.derive({
      peer: { publicKey: host.x25519.publicKey },
      role: 'consumer',
      self: consumer.x25519,
      transportContext: pairingSecret,
      transportId: Relay.transportId,
    })
    const keys_host = Session.derive({
      peer: { publicKey: consumer.x25519.publicKey },
      role: 'host',
      self: host.x25519,
      transportContext: pairingSecret,
      transportId: Relay.transportId,
    })
    return {
      consumer: Relay.createCipher({
        consumerPublicKey: consumer.x25519.publicKey,
        keys: keys_consumer,
        role: 'consumer',
      }),
      host: Relay.createCipher({
        consumerPublicKey: consumer.x25519.publicKey,
        keys: keys_host,
        role: 'host',
      }),
    }
  }

  test('round-trips envelopes in both directions', () => {
    const { consumer, host } = pair()
    const ready = consumer.seal(Envelope.ready())
    expect(host.open(ready)).toEqual(Envelope.ready())
    const responses = Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'pong' }])
    expect(consumer.open(host.seal(responses))).toEqual(responses)
  })

  test('rejects a replayed envelope', () => {
    const { consumer, host } = pair()
    const sealed = consumer.seal(Envelope.ready())
    host.open(sealed)
    expect(() => host.open(sealed)).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: nonce not strictly greater than HWM
      Details: hwm=1, received counter=1]
    `,
    )
  })

  test('rejects tampered ciphertext without advancing the high-water mark', () => {
    const { consumer, host } = pair()
    const sealed = consumer.seal(Envelope.ready())
    const tampered = {
      ...sealed,
      payload: { ...sealed.payload, ct: `${sealed.payload.ct.slice(0, -2)}AA` },
    }
    expect(() => host.open(tampered)).toThrow()
    // The legitimate frame still opens — the forged one must not burn
    // the nonce window.
    expect(host.open(sealed)).toEqual(Envelope.ready())
  })

  test('rejects an envelope whose `from` does not identify the peer', () => {
    const { consumer } = pair()
    const sealed = consumer.seal(Envelope.ready())
    expect(() => consumer.open(sealed)).toThrowErrorMatchingInlineSnapshot(
      `
      [ProtocolError: encrypted envelope \`from\` does not identify the peer
      Details: expected host, received consumer]
    `,
    )
  })

  test('rejects sealing an `encrypted` envelope', () => {
    const { consumer } = pair()
    const sealed = consumer.seal(Envelope.ready())
    expect(() => consumer.seal(sealed)).toThrowErrorMatchingInlineSnapshot(
      '[ProtocolError: inner envelope type `encrypted` is forbidden]',
    )
  })
})

describe('createChannel', () => {
  const keypair = Crypto.randomKeypair()
  const id = Relay.channelId({ consumerPublicKey, pairingSecret })

  /** A `createChannel` bound to a fake fetch for receive-loop tests. */
  function channel(options: {
    fetch: typeof globalThis.fetch
    pollInterval?: number | undefined
    receive: 'poll' | 'sse'
  }) {
    return Relay.createChannel({
      channelId: id,
      fetch: options.fetch,
      keypair,
      peer: 'consumer',
      ...(options.pollInterval === undefined ? {} : { pollInterval: options.pollInterval }),
      receive: options.receive,
      url: 'https://relay.test',
    })
  }

  /** Collects the events/closures of a single subscription. */
  function listen(ch: Relay.createChannel.ReturnType) {
    const controller = new AbortController()
    const errors: Error[] = []
    const events: string[] = []
    let close: { cause?: Error | undefined } | undefined
    const opened = ch.subscribe({
      onClose: (cause) => {
        close = { cause }
      },
      onError: (error) => errors.push(error),
      onEvent: (data) => events.push(data),
      signal: controller.signal,
    })
    return {
      abort: () => controller.abort(),
      closed: () => close,
      errors,
      events,
      opened,
    }
  }

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function until(predicate: () => boolean, timeout = 4000) {
    return new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = () => {
        if (predicate()) return resolve()
        if (Date.now() - start > timeout) return reject(new Error('until: timed out'))
        setTimeout(tick, 2)
      }
      tick()
    })
  }

  /** Fake relay that replays a scripted sequence of poll responses. */
  function pollServer(script: readonly ({ body?: string; status: number } | { throw: string })[]) {
    const calls: { headers: Headers; url: string }[] = []
    let index = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ headers: new Headers(init?.headers), url: String(input) })
      const step = script[index] ?? { status: 204 }
      index += 1
      if ('throw' in step) throw new TypeError(step.throw)
      return new Response(step.body ?? null, { status: step.status })
    }
    return { calls, fetch }
  }

  /** Fake relay that streams SSE blocks the test pushes by hand. */
  function sseServer() {
    const encoder = new TextEncoder()
    const cancels: number[] = []
    const calls: string[] = []
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    let statusFor: (call: number) => number = () => 200
    const fetch: typeof globalThis.fetch = async (input) => {
      const call = calls.length
      calls.push(String(input))
      const status = statusFor(call)
      if (status !== 200) return new Response(null, { status })
      const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancels.push(call)
        },
        start: (controller) => {
          controllers.push(controller)
        },
      })
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      })
    }
    return {
      calls,
      cancels,
      controllers,
      end: (conn = controllers.length - 1) => controllers[conn]?.close(),
      fetch,
      push: (block: string, conn = controllers.length - 1) =>
        controllers[conn]?.enqueue(encoder.encode(block)),
      setStatus: (fn: (call: number) => number) => {
        statusFor = fn
      },
    }
  }

  const sse = {
    closed: () => 'event: closed\ndata: bye\n\n',
    message: (data: string) => `event: message\ndata: ${data}\n\n`,
    opened: () => 'event: opened\ndata: ok\n\n',
  }

  test('poll: signs each GET with `wait=0` and `Accept: application/json`', async () => {
    const server = pollServer([{ status: 204 }])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await sub.opened
    expect(server.calls[0]?.url.endsWith('/consumer?wait=0')).toBe(true)
    expect(server.calls[0]?.headers.get('accept')).toBe('application/json')
    expect(server.calls[0]?.headers.get('signature-input')).toContain('name="wait"')
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('poll: drains a buffered burst back-to-back, then resumes interval polling', async () => {
    const server = pollServer([
      { body: 'a', status: 200 },
      { body: 'b', status: 200 },
      { body: 'c', status: 200 },
      { status: 204 },
      { body: 'd', status: 200 },
    ])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await sub.opened
    await until(() => sub.events.length >= 4)
    expect(sub.events).toEqual(['a', 'b', 'c', 'd'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('poll: reconnects after a 409 supersession and keeps delivering', async () => {
    const server = pollServer([
      { body: 'a', status: 200 },
      { status: 409 },
      { body: 'b', status: 200 },
    ])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await sub.opened
    await until(() => sub.events.length >= 2)
    expect(sub.events).toEqual(['a', 'b'])
    expect(server.calls.length).toBeGreaterThanOrEqual(3)
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('poll: rejects the first subscribe when the relay 5xxs before opening', async () => {
    const server = pollServer([{ status: 503 }])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await expect(sub.opened).rejects.toMatchObject({ name: 'Relay.HttpError', status: 503 })
  })

  test('poll: ends with onClose(cause) on a terminal 4xx after opening', async () => {
    const server = pollServer([{ status: 204 }, { status: 403 }])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await sub.opened
    await until(() => Boolean(sub.closed()))
    expect(sub.closed()?.cause).toMatchObject({ name: 'Relay.HttpError', status: 403 })
  })

  test('poll: surfaces a transient 5xx via onError and recovers on reconnect', async () => {
    const server = pollServer([
      { status: 204 },
      { status: 503 },
      { status: 204 },
      { body: 'ok', status: 200 },
    ])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await sub.opened
    await until(() => sub.events.includes('ok'))
    expect(sub.errors.map((error) => error.name)).toContain('Relay.HttpError')
    expect(sub.events).toEqual(['ok'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('poll: stops issuing requests once aborted', async () => {
    const server = pollServer([])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await sub.opened
    sub.abort()
    await delay(50)
    const count = server.calls.length
    await delay(50)
    expect(server.calls.length).toBe(count)
    expect(sub.closed()?.cause).toBeUndefined()
  })

  test('sse: delivers `opened` then a burst of messages in order', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened())
    await sub.opened
    server.push(sse.message('a'))
    server.push(sse.message('b'))
    server.push(sse.message('c'))
    await until(() => sub.events.length >= 3)
    expect(sub.events).toEqual(['a', 'b', 'c'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('sse: reassembles a single message split across chunks', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened())
    await sub.opened
    server.push('event: message\ndata: hel')
    await delay(10)
    server.push('lo\n\n')
    await until(() => sub.events.length >= 1)
    expect(sub.events).toEqual(['hello'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('sse: delivers multiple messages batched in one chunk', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened() + sse.message('a') + sse.message('b') + sse.message('c'))
    await sub.opened
    await until(() => sub.events.length >= 3)
    expect(sub.events).toEqual(['a', 'b', 'c'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('sse: ignores comments and dataless events', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened())
    await sub.opened
    server.push(': keepalive\n\n')
    server.push('event: message\n\n')
    server.push(sse.message('real'))
    await until(() => sub.events.length >= 1)
    expect(sub.events).toEqual(['real'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('sse: reconnects after a server-sent `closed` event', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened())
    await sub.opened
    server.push(sse.closed())
    await until(() => server.controllers.length >= 2)
    server.push(sse.message('x'))
    await until(() => sub.events.includes('x'))
    expect(sub.events).toEqual(['x'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('sse: rejects the first subscribe when the stream fails to open', async () => {
    const server = sseServer()
    server.setStatus(() => 500)
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await expect(sub.opened).rejects.toMatchObject({ name: 'Relay.HttpError', status: 500 })
  })

  test('sse: cancels the stream and reports onClose on abort', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened())
    await sub.opened
    sub.abort()
    await until(() => server.cancels.includes(0))
    await until(() => Boolean(sub.closed()))
    expect(sub.closed()?.cause).toBeUndefined()
  })

  test('sse: reconnects after a raw stream EOF (no `closed` event)', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened())
    await sub.opened
    server.push(sse.message('a'))
    await until(() => sub.events.includes('a'))
    // The stream just ends — a dropped connection, not a server `closed`
    // event. The loop should silently re-subscribe.
    server.end()
    await until(() => server.controllers.length >= 2)
    server.push(sse.message('b'))
    await until(() => sub.events.includes('b'))
    expect(sub.events).toEqual(['a', 'b'])
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })

  test('sse: keeps reconnect backoff low across repeated healthy closures', async () => {
    const server = sseServer()
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    const cycles = 6
    const start = Date.now()
    for (let i = 0; i < cycles; i++) {
      await until(() => server.controllers.length >= i + 1)
      server.push(sse.opened())
      server.push(sse.message(`m${i}`))
      await until(() => sub.events.length >= i + 1)
      server.end()
    }
    await until(() => server.controllers.length >= cycles + 1)
    const elapsed = Date.now() - start
    expect(sub.events).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    // Each healthy reopen resets the backoff, so every gap stays
    // ~250-500ms. Without the reset, six escalating sleeps would total
    // >11s — this bound only passes when the backoff is reset.
    expect(elapsed).toBeLessThan(6000)
    sub.abort()
    await until(() => Boolean(sub.closed()))
  }, 15_000)

  test('sse: recovers after several failed reconnections', async () => {
    const server = sseServer()
    // First connect succeeds (so the caller's promise resolves), then
    // two reconnects 503 before the relay comes back.
    server.setStatus((call) => (call === 1 || call === 2 ? 503 : 200))
    const sub = listen(channel({ fetch: server.fetch, receive: 'sse' }))
    await until(() => server.controllers.length >= 1)
    server.push(sse.opened())
    await sub.opened
    server.push(sse.message('a'))
    await until(() => sub.events.includes('a'))
    server.end(0)
    await until(() => server.controllers.length >= 2)
    server.push(sse.message('b'))
    await until(() => sub.events.includes('b'))
    expect(sub.events).toEqual(['a', 'b'])
    expect(sub.errors.filter((error) => error.name === 'Relay.HttpError').length).toBe(2)
    sub.abort()
    await until(() => Boolean(sub.closed()))
  }, 15_000)

  test('poll: recovers from an intermittent network error', async () => {
    const server = pollServer([
      { status: 204 },
      { throw: 'network down' },
      { status: 204 },
      { body: 'ok', status: 200 },
    ])
    const sub = listen(channel({ fetch: server.fetch, pollInterval: 1, receive: 'poll' }))
    await sub.opened
    await until(() => sub.events.includes('ok'))
    expect(sub.events).toEqual(['ok'])
    expect(sub.errors.some((error) => error.message.includes('network down'))).toBe(true)
    sub.abort()
    await until(() => Boolean(sub.closed()))
  })
})
