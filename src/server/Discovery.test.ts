import { describe, expect, test } from 'vp/test'
import { Discovery } from 'wata'
import { hostWellknown, consumerWellknown } from 'wata/server'

// 43-char unpadded base64url Ed25519 pubkey per uRPC discovery.md §2.2.
const identity_pubkey = 'A'.repeat(43)

describe('hostWellknown', () => {
  test('serves the host.json document with content-type application/json', async () => {
    const server = hostWellknown({
      identity_pubkey,
      meta: { name: 'Example Wallet', icon: 'https://wallet.example/logo.png' },
      transports: {
        'device-code': {
          register_url: 'https://wallet.example/auth/device/register',
          token_url: 'https://wallet.example/auth/device/token',
        },
      },
    })

    const response = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    expect({
      status: response.status,
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
    }).toMatchInlineSnapshot(`
    	{
    	  "cacheControl": "public, max-age=60",
    	  "contentType": "application/json",
    	  "status": 200,
    	}
    `)
    expect(await response.json()).toMatchInlineSnapshot(`
    	{
    	  "icon": "https://wallet.example/logo.png",
    	  "id": "wallet.example",
    	  "identity_pubkey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    	  "name": "Example Wallet",
    	  "origin": "https://wallet.example",
    	  "transports": {
    	    "device-code": {
    	      "register_url": "https://wallet.example/auth/device/register",
    	      "token_url": "https://wallet.example/auth/device/token",
    	    },
    	  },
    	  "version": "1.0",
    	}
    `)
  })

  test('host_id defaults to the request URL hostname when omitted', async () => {
    const server = hostWellknown({
      identity_pubkey,
      meta: { name: 'Tenant Wallet' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const response = await server.fetch(
      new Request('https://tenant-a.wallet.example:8443/.well-known/urpc/host.json'),
    )
    const body = (await response.json()) as Discovery.HostDocument
    expect({ status: response.status, origin: body.origin, id: body.id }).toMatchInlineSnapshot(`
      {
        "id": "tenant-a.wallet.example",
        "origin": "https://tenant-a.wallet.example:8443",
        "status": 200,
      }
    `)
  })

  test('explicit `origin` / `id` overrides take precedence over the request URL', async () => {
    const server = hostWellknown({
      identity_pubkey,
      origin: 'https://canonical.wallet.example',
      id: 'canonical-id',
      meta: { name: 'Canonical Wallet' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const response = await server.fetch(
      new Request('https://request-host.example/.well-known/urpc/host.json'),
    )
    const body = (await response.json()) as Discovery.HostDocument
    expect({ origin: body.origin, id: body.id }).toMatchInlineSnapshot(`
      {
        "id": "canonical-id",
        "origin": "https://canonical.wallet.example",
      }
    `)
  })

  test('returns 400 when neither `name` nor `meta.name` is supplied', async () => {
    const server = hostWellknown({
      identity_pubkey,
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const response = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    expect(response.status).toMatchInlineSnapshot(`400`)
    const body = (await response.json()) as { error: string; error_description: string }
    expect(body).toMatchInlineSnapshot(`
    	{
    	  "error": "invalid_request",
    	  "error_description": "\`name\` is required (pass \`name\` directly or via \`meta.name\`)",
    	}
    `)
  })

  test('returns 400 when `identity_pubkey` is missing (required per spec §2.2)', async () => {
    const server = hostWellknown({
      meta: { name: 'No Pubkey Wallet' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const response = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    expect(response.status).toMatchInlineSnapshot(`400`)
    const body = (await response.json()) as { error: string; error_description: string }
    expect(body).toMatchInlineSnapshot(`
    	{
    	  "error": "invalid_request",
    	  "error_description": "\`identity_pubkey\` is required (unpadded base64url Ed25519 public key, 43 chars)",
    	}
    `)
  })

  test('returns 400 when `transports` map is empty', async () => {
    const server = hostWellknown({
      identity_pubkey,
      meta: { name: 'Empty Wallet' },
      transports: {},
    })
    const response = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    expect(response.status).toMatchInlineSnapshot(`400`)
  })

  test('pre-built `document` is served verbatim and validated upfront', async () => {
    const document: Discovery.HostDocument = {
      version: '1.0',
      origin: 'https://wallet.example',
      id: 'wallet.example',
      name: 'Prebuilt',
      identity_pubkey,
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    }
    const server = hostWellknown({ document })
    const response = await server.fetch(
      new Request('https://other.example/.well-known/urpc/host.json'),
    )
    const body = (await response.json()) as Discovery.HostDocument
    expect({ status: response.status, origin: body.origin }).toMatchInlineSnapshot(`
      {
        "origin": "https://wallet.example",
        "status": 200,
      }
    `)
  })
})

describe('consumerWellknown', () => {
  test('serves the consumer.json document with content-type application/json', async () => {
    const server = consumerWellknown({
      meta: { name: 'Acme CLI', icon: 'https://acme.dev/icon.png' },
      callback_urls: ['https://acme.dev/cb'],
    })

    const response = await server.fetch(
      new Request('https://acme.dev/.well-known/urpc/consumer.json'),
    )
    expect({
      status: response.status,
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
    }).toMatchInlineSnapshot(`
    	{
    	  "cacheControl": "public, max-age=3600",
    	  "contentType": "application/json",
    	  "status": 200,
    	}
    `)
    expect(await response.json()).toMatchInlineSnapshot(`
    	{
    	  "callback_urls": [
    	    "https://acme.dev/cb",
    	  ],
    	  "icon": "https://acme.dev/icon.png",
    	  "id": "acme.dev",
    	  "name": "Acme CLI",
    	  "origin": "https://acme.dev",
    	  "version": "1.0",
    	}
    `)
  })

  test('consumer_id defaults to the request URL hostname when omitted', async () => {
    const server = consumerWellknown({ meta: { name: 'Local CLI' } })
    const response = await server.fetch(
      new Request('https://app.example/.well-known/urpc/consumer.json'),
    )
    const body = (await response.json()) as Discovery.ConsumerDocument
    expect({ status: response.status, origin: body.origin, id: body.id }).toMatchInlineSnapshot(`
      {
        "id": "app.example",
        "origin": "https://app.example",
        "status": 200,
      }
    `)
  })

  test('returns 400 on invalid callback_urls (wildcard rejected)', async () => {
    const server = consumerWellknown({ callback_urls: ['https://*.app.example/cb'] })
    const response = await server.fetch(
      new Request('https://app.example/.well-known/urpc/consumer.json'),
    )
    expect(response.status).toMatchInlineSnapshot(`400`)
  })
})

describe('etag', () => {
  test('hostWellknown emits a strong ETag on the 200 response', async () => {
    const server = hostWellknown({
      identity_pubkey,
      meta: { name: 'Etag Wallet' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const response = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    const tag = response.headers.get('etag')
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/)
  })

  test('hostWellknown returns 304 when If-None-Match matches the current ETag', async () => {
    const server = hostWellknown({
      identity_pubkey,
      meta: { name: 'Etag Wallet' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const first = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json'),
    )
    const tag = first.headers.get('etag')!
    const conditional = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json', {
        headers: { 'if-none-match': tag },
      }),
    )
    expect({ status: conditional.status, etag: conditional.headers.get('etag') })
      .toMatchInlineSnapshot(`
        {
          "etag": "${tag}",
          "status": 304,
        }
      `)
    expect(await conditional.text()).toMatchInlineSnapshot(`""`)
  })

  test('hostWellknown returns 200 when If-None-Match does not match', async () => {
    const server = hostWellknown({
      identity_pubkey,
      meta: { name: 'Etag Wallet' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const response = await server.fetch(
      new Request('https://wallet.example/.well-known/urpc/host.json', {
        headers: { 'if-none-match': '"stale-etag"' },
      }),
    )
    expect(response.status).toMatchInlineSnapshot(`200`)
  })

  test('consumerWellknown emits an ETag and honors If-None-Match', async () => {
    const server = consumerWellknown({
      meta: { name: 'Etag CLI' },
      callback_urls: ['https://acme.dev/cb'],
    })
    const first = await server.fetch(new Request('https://acme.dev/.well-known/urpc/consumer.json'))
    const tag = first.headers.get('etag')!
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/)
    const conditional = await server.fetch(
      new Request('https://acme.dev/.well-known/urpc/consumer.json', {
        headers: { 'if-none-match': tag },
      }),
    )
    expect(conditional.status).toMatchInlineSnapshot(`304`)
  })
})

describe('listener', () => {
  test('host and consumer factories expose a Node-shaped listener', () => {
    const host = hostWellknown({
      identity_pubkey,
      meta: { name: 'X' },
      transports: { 'device-code': { register_url: 'https://x/r', token_url: 'https://x/t' } },
    })
    const consumer = consumerWellknown({ meta: { name: 'Y' } })
    expect({
      hostListener: typeof host.listener,
      consumerListener: typeof consumer.listener,
    }).toMatchInlineSnapshot(`
      {
        "consumerListener": "function",
        "hostListener": "function",
      }
    `)
  })
})
