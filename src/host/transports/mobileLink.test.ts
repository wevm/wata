import { Base64 } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Crypto, Discovery, Envelope, Identity, SessionKey } from 'wata'
import { mobileLink } from 'wata/host'

import * as MobileLinkEnvelope from '../../internal/MobileLinkEnvelope.js'

const hostIdentity = Crypto.randomKeypair()
const consumer = Crypto.randomKeypair()
const consumerOrigin = 'https://app.example'
const returnUrl = 'https://app.example/urpc/cb'

function consumerFetch(callbackUrls: readonly string[]): typeof globalThis.fetch {
  const doc = {
    callback_urls: callbackUrls,
    id: 'app.example',
    name: 'App',
    origin: consumerOrigin,
    version: '1.0',
  }
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === Discovery.consumerUrl(consumerOrigin))
      return new Response(JSON.stringify(doc), {
        headers: { 'content-type': 'application/json' },
      })
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
}

function initialLink(request: Envelope.Envelope): string {
  const url = new URL('examplewallet://request')
  url.searchParams.set('id', consumerOrigin)
  url.searchParams.set('message', MobileLinkEnvelope.encodeJson(request))
  url.searchParams.set('pubkey', Crypto.encodePublicKey(consumer.x25519.publicKey))
  url.searchParams.set('return_url', returnUrl)
  url.searchParams.set('version', '1')
  return url.toString()
}

function setup(callbackUrls: readonly string[] = [returnUrl]) {
  const links: string[] = []
  const transport = mobileLink({
    fetch: consumerFetch(callbackUrls),
    openLink: (url) => {
      links.push(url)
    },
    scheme: 'examplewallet',
  })
  transport.bind?.({ identity: Identity.fromPrivateKey(hostIdentity.privateKey) })
  const messages: Envelope.Envelope[] = []
  transport.on('message', (envelope) => messages.push(envelope))
  return { links, messages, transport }
}

describe('mobileLink', () => {
  test('verifies the consumer, signs identity, and answers via return_url', async () => {
    const { links, messages, transport } = setup()
    await transport.start()
    await transport.handleUrl(
      initialLink(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
      ),
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'rpc-requests' })

    await transport.send(Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: { ok: true } }]))
    expect(links).toHaveLength(1)
    const callback = new URL(links[0]!)
    expect(callback.origin + callback.pathname).toBe(returnUrl)
    expect(callback.searchParams.get('version')).toBe('1')
    const pubkeyHost = Crypto.decodePublicKey(callback.searchParams.get('pubkey')!)
    const signature = Base64.toBytes(callback.searchParams.get('identity_sig')!)
    const shared = SessionKey.shared({
      privateKey: consumer.x25519.privateKey,
      publicKey: pubkeyHost,
    })
    expect(
      MobileLinkEnvelope.verifyIdentity({
        identityPublicKey: hostIdentity.publicKey,
        publicKeyConsumer: consumer.x25519.publicKey,
        publicKeyHost: pubkeyHost,
        shared,
        signature,
      }),
    ).toBe(true)
    const keys = MobileLinkEnvelope.deriveKeys({
      identityPublicKey: hostIdentity.publicKey,
      peerPublicKey: pubkeyHost,
      role: 'consumer',
      self: consumer.x25519,
    })
    const opened = MobileLinkEnvelope.open({
      encrypted: Envelope.parse(
        MobileLinkEnvelope.decodeJson(callback.searchParams.get('message')!),
      ) as Extract<Envelope.Envelope, { type: 'encrypted' }>,
      key: keys.h2c,
      publicKeyConsumer: consumer.x25519.publicKey,
    })
    expect(opened).toMatchObject({ payload: [{ id: 1, result: { ok: true } }] })
  })

  test('builds without `openLink` for discovery-only use', () => {
    expect(() => mobileLink({ scheme: 'examplewallet' })).not.toThrow()
  })

  test('throws a clear error when `send` needs `openLink` but none was given', async () => {
    const transport = mobileLink({ fetch: consumerFetch([returnUrl]), scheme: 'examplewallet' })
    transport.bind?.({ identity: Identity.fromPrivateKey(hostIdentity.privateKey) })
    await transport.start()
    await transport.handleUrl(
      initialLink(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
      ),
    )
    await expect(
      transport.send(Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: { ok: true } }])),
    ).rejects.toThrowError(/mobile-link host requires `openLink`/)
  })

  test('rejects a consumer whose callback is not in the allowlist', async () => {
    const { links, messages, transport } = setup([])
    await transport.start()
    await transport.handleUrl(
      initialLink(Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'ping', params: [] }])),
    )
    expect(messages).toHaveLength(0)
    expect(links).toHaveLength(1)
    const callback = new URL(links[0]!)
    expect(callback.searchParams.get('pubkey')).toBeNull()
    expect(callback.searchParams.get('identity_sig')).toBeNull()
    const error = Envelope.parse(
      MobileLinkEnvelope.decodeJson(callback.searchParams.get('message')!),
    )
    expect(error).toMatchObject({ payload: [{ error: { code: -32600 }, id: 1 }] })
  })
})
