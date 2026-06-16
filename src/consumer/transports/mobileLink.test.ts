import { Base64 } from 'ox'
import { describe, expect, test } from 'vp/test'
import { Crypto, Discovery, Envelope, Identity, Nonce, Session } from 'wata'

import * as MobileLinkEnvelope from '../../internal/MobileLinkEnvelope.js'
import { mobileLink } from './mobileLink.js'

const returnUrl = 'https://app.example/urpc/cb'
const consumerId = 'https://app.example'

const identity = Crypto.randomKeypair()
const hostDoc = Discovery.parseHost({
  id: 'wallet.example',
  identity_pubkey: Crypto.encodePublicKey(identity.publicKey),
  name: 'Wallet',
  origin: 'https://wallet.example',
  transports: {
    'mobile-link': { scheme: 'examplewallet', universal_link: 'https://wallet.example/urpc' },
  },
  version: '1.0',
})

function setup() {
  const links: string[] = []
  const transport = mobileLink({
    host: hostDoc,
    id: consumerId,
    openLink: (url) => {
      links.push(url)
    },
    returnUrl,
  })
  const messages: Envelope.Envelope[] = []
  transport.on('message', (envelope) => messages.push(envelope))
  return { links, messages, transport }
}

/** Simulate the host answering an initial link, returning the callback URL. */
function hostRespond(
  initialLink: string,
  response: Envelope.Envelope,
  options: { nonce?: bigint; tamperSig?: boolean } = {},
) {
  const url = new URL(initialLink)
  const publicKeyConsumer = Crypto.decodePublicKey(url.searchParams.get('pubkey')!)
  const hostEph = Crypto.randomKeypair()
  const shared = Session.shared({
    privateKey: hostEph.x25519.privateKey,
    publicKey: publicKeyConsumer,
  })
  const signature = MobileLinkEnvelope.signIdentity({
    identity: Identity.fromPrivateKey(identity.privateKey),
    publicKeyConsumer,
    publicKeyHost: hostEph.x25519.publicKey,
    shared,
  })
  if (options.tamperSig) signature[0] = (signature[0] ?? 0) ^ 0xff
  const keys = MobileLinkEnvelope.deriveKeys({
    identityPublicKey: identity.publicKey,
    peerPublicKey: publicKeyConsumer,
    role: 'host',
    self: hostEph.x25519,
  })
  const sealed = MobileLinkEnvelope.seal({
    envelope: response,
    from: 'host',
    key: keys.h2c,
    nonce: Nonce.fromCounter(options.nonce ?? 1n),
    publicKeyConsumer,
  })
  const callback = new URL(returnUrl)
  callback.searchParams.set('identity_sig', Base64.fromBytes(signature, { pad: false, url: true }))
  callback.searchParams.set('message', MobileLinkEnvelope.encodeJson(sealed))
  callback.searchParams.set('pubkey', Crypto.encodePublicKey(hostEph.x25519.publicKey))
  callback.searchParams.set('version', '1')
  return { callback: callback.toString(), hostEph, keys, publicKeyConsumer }
}

describe('mobileLink', () => {
  test('builds the initial deep link with the required parameters', async () => {
    const { links, transport } = setup()
    await transport.start()
    await transport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
    )
    expect(links).toHaveLength(1)
    const url = new URL(links[0]!)
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('wallet.example')
    expect(url.searchParams.get('version')).toBe('1')
    expect(url.searchParams.get('id')).toBe(consumerId)
    expect(url.searchParams.get('return_url')).toBe(returnUrl)
    expect(url.searchParams.get('pubkey')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('message')).toBeTruthy()
  })

  test('accepts the host deferred to `start({ host })`', async () => {
    const links: string[] = []
    const transport = mobileLink({
      id: consumerId,
      openLink: (url) => {
        links.push(url)
      },
      returnUrl,
    })
    await transport.start({ host: hostDoc })
    await transport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
    )
    expect(links).toHaveLength(1)
    expect(new URL(links[0]!).host).toBe('wallet.example')
  })

  test('throws when no host is supplied at construction or start', async () => {
    const transport = mobileLink({ id: consumerId, openLink: () => {}, returnUrl })
    await expect(transport.start()).rejects.toThrowError(/mobile-link host must be supplied/)
  })

  test('builds without `openLink` for discovery-only use', () => {
    expect(() => mobileLink({ host: hostDoc, id: consumerId, returnUrl })).not.toThrow()
  })

  test('throws a clear error when `send` needs `openLink` but none was given', async () => {
    const transport = mobileLink({ host: hostDoc, id: consumerId, returnUrl })
    await transport.start()
    await expect(
      transport.send(
        Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
      ),
    ).rejects.toThrowError(/mobile-link consumer requires `openLink`/)
  })

  test('verifies the host identity and decrypts the handshake response', async () => {
    const { links, messages, transport } = setup()
    await transport.start()
    await transport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
    )
    const { callback } = hostRespond(
      links[0]!,
      Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: { ok: true } }]),
    )
    transport.handleUrl(callback)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      payload: [{ id: 1, result: { ok: true } }],
      type: 'rpc-responses',
    })
  })

  test('rejects a forged host identity signature', async () => {
    const { links, messages, transport } = setup()
    await transport.start()
    await transport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
    )
    const { callback } = hostRespond(
      links[0]!,
      Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'ok' }]),
      { tamperSig: true },
    )
    transport.handleUrl(callback)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      payload: [{ error: { code: -32600 }, id: 1 }],
      type: 'rpc-responses',
    })
  })

  test('rejects an out-of-order subsequent frame', async () => {
    const { links, messages, transport } = setup()
    await transport.start()
    await transport.send(
      Envelope.rpcRequests([{ id: 1, jsonrpc: '2.0', method: 'wallet_connect', params: [] }]),
    )
    const handshake = hostRespond(
      links[0]!,
      Envelope.rpcResponses([{ id: 1, jsonrpc: '2.0', result: 'ok' }]),
    )
    transport.handleUrl(handshake.callback)
    expect(messages).toHaveLength(1)

    // Replay nonce 1 in a subsequent frame — must be rejected.
    const replay = MobileLinkEnvelope.seal({
      envelope: Envelope.rpcResponses([{ id: 2, jsonrpc: '2.0', result: 'late' }]),
      from: 'host',
      key: handshake.keys.h2c,
      nonce: Nonce.fromCounter(1n),
      publicKeyConsumer: handshake.publicKeyConsumer,
    })
    const url = new URL(returnUrl)
    url.searchParams.set('message', MobileLinkEnvelope.encodeJson(replay))
    url.searchParams.set('version', '1')
    transport.handleUrl(url.toString())
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      payload: [{ error: { code: -32600 } }],
      type: 'rpc-responses',
    })
  })
})
