/**
 * Tests for the RFC 9421 / RFC 9530 helpers. Includes the
 * normative Ed25519 vector from RFC 9421 §B.2.4.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { Base64, Bytes, Ed25519 } from 'ox'
import { describe, expect, test } from 'vp/test'

import * as MessageSig from './MessageSig.js'

describe('contentDigest', () => {
  test('returns sha-256=:<base64>: for a string body', () => {
    expect(MessageSig.contentDigest('{"hello": "world"}')).toMatchInlineSnapshot(
      `"sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:"`,
    )
  })

  test('returns the same value for a string body and its UTF-8 bytes', () => {
    const body = '{"hello": "world"}'
    expect(MessageSig.contentDigest(body)).toBe(MessageSig.contentDigest(Bytes.fromString(body)))
  })
})

describe('signatureBase', () => {
  test('matches RFC 9421 §B.2.4 Ed25519 vector', () => {
    // The vector body is `{"hello": "world"}` and the canonical
    // base uses sha-512 over those bytes. We replay the exact bytes
    // the RFC gives so the resulting base is byte-identical to
    // §B.2.4.3.
    const headers = {
      'Content-Digest':
        'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
      'Content-Length': '18',
      'Content-Type': 'application/json',
      Date: 'Tue, 20 Apr 2021 02:07:55 GMT',
      Host: 'example.com',
    }
    const base = MessageSig.signatureBase({
      components: ['@method', '@authority', '@path', 'content-digest', 'content-length', 'content-type'],
      message: {
        headers,
        method: 'POST',
        url: 'https://example.com/foo?param=Value&Pet=dog',
      },
      parameters: { created: 1618884473, keyid: 'test-key-ed25519' },
    })
    expect(base).toMatchInlineSnapshot(`
      ""@method": POST
      "@authority": example.com
      "@path": /foo
      "content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:
      "content-length": 18
      "content-type": application/json
      "@signature-params": ("@method" "@authority" "@path" "content-digest" "content-length" "content-type");created=1618884473;keyid="test-key-ed25519""
    `)
  })

  test('lowercases the @authority host and strips default ports', () => {
    expect(
      MessageSig.signatureBase({
        components: ['@authority'],
        message: { headers: {}, method: 'POST', url: 'https://EXAMPLE.COM:443/foo' },
        parameters: { created: 1, keyid: 'k' },
      }),
    ).toContain('"@authority": example.com\n')
  })

  test('preserves non-default ports in @authority', () => {
    expect(
      MessageSig.signatureBase({
        components: ['@authority'],
        message: { headers: {}, method: 'POST', url: 'https://example.com:8443/foo' },
        parameters: { created: 1, keyid: 'k' },
      }),
    ).toContain('"@authority": example.com:8443\n')
  })

  test('trims leading/trailing whitespace on header values per RFC 9421 §2.1', () => {
    const base = MessageSig.signatureBase({
      components: ['content-type'],
      message: {
        headers: { 'content-type': '  application/json  ' },
        method: 'POST',
        url: 'https://example.com/foo',
      },
      parameters: { created: 1, keyid: 'k' },
    })
    expect(base).toContain('"content-type": application/json\n')
  })

  test('throws MissingHeaderError when a header component is absent', () => {
    expect(() =>
      MessageSig.signatureBase({
        components: ['content-digest'],
        message: { headers: {}, method: 'POST', url: 'https://example.com/foo' },
        parameters: { created: 1, keyid: 'k' },
      }),
    ).toThrowErrorMatchingInlineSnapshot(`[MessageSig.MissingHeaderError: missing header \`content-digest\` for signature base]`)
  })
})

describe('sign / verify (Ed25519 round-trip)', () => {
  const keypair = Ed25519.createKeyPair()
  const message = {
    headers: {
      'content-digest': MessageSig.contentDigest('{"hi":1}'),
      'content-type': 'application/json',
      'urpc-auth-req-id': 'abc123',
      'urpc-public-key': 'pubkey',
    },
    method: 'POST',
    url: 'https://wallet.example/auth/webhook',
  }
  const components = [
    '@method',
    '@target-uri',
    '@authority',
    'content-type',
    'content-digest',
    'urpc-auth-req-id',
    'urpc-public-key',
  ]

  test('verifies a freshly-signed message', () => {
    const { signature, signatureInput } = MessageSig.sign({
      components,
      message,
      parameters: {
        alg: 'ed25519',
        created: 1730999940,
        keyid: 'wallet.example#identity',
        nonce: 'random-bytes',
      },
      privateKey: keypair.privateKey,
    })
    const verified = MessageSig.verify({
      message: {
        ...message,
        headers: { ...message.headers, signature, 'signature-input': signatureInput },
      },
      publicKey: keypair.publicKey,
      requiredComponents: components,
    })
    expect(verified).toBe(true)
  })

  test('rejects tampered body via Content-Digest mismatch (caller-detected)', () => {
    const { signature, signatureInput } = MessageSig.sign({
      components,
      message,
      parameters: { alg: 'ed25519', created: 1, keyid: 'k' },
      privateKey: keypair.privateKey,
    })
    const tamperedDigest = MessageSig.contentDigest('{"tampered":true}')
    const verified = MessageSig.verify({
      message: {
        ...message,
        headers: {
          ...message.headers,
          'content-digest': tamperedDigest,
          signature,
          'signature-input': signatureInput,
        },
      },
      publicKey: keypair.publicKey,
    })
    expect(verified).toBe(false)
  })

  test('rejects tampered url', () => {
    const { signature, signatureInput } = MessageSig.sign({
      components,
      message,
      parameters: { alg: 'ed25519', created: 1, keyid: 'k' },
      privateKey: keypair.privateKey,
    })
    const verified = MessageSig.verify({
      message: {
        ...message,
        headers: { ...message.headers, signature, 'signature-input': signatureInput },
        url: 'https://attacker.example/auth/webhook',
      },
      publicKey: keypair.publicKey,
    })
    expect(verified).toBe(false)
  })

  test('throws MissingComponentError when requiredComponents not covered', () => {
    const { signature, signatureInput } = MessageSig.sign({
      components: ['@method', '@target-uri'],
      message,
      parameters: { alg: 'ed25519', created: 1, keyid: 'k' },
      privateKey: keypair.privateKey,
    })
    expect(() =>
      MessageSig.verify({
        message: {
          ...message,
          headers: { ...message.headers, signature, 'signature-input': signatureInput },
        },
        publicKey: keypair.publicKey,
        requiredComponents: ['content-digest'],
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[MessageSig.MissingComponentError: signature does not cover required component \`content-digest\`]`,
    )
  })

  test('throws InvalidSignatureError when Signature header missing', () => {
    const { signatureInput } = MessageSig.sign({
      components,
      message,
      parameters: { alg: 'ed25519', created: 1, keyid: 'k' },
      privateKey: keypair.privateKey,
    })
    expect(() =>
      MessageSig.verify({
        message: { ...message, headers: { ...message.headers, 'signature-input': signatureInput } },
        publicKey: keypair.publicKey,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[MessageSig.InvalidSignatureError: missing \`Signature\` header]`,
    )
  })
})

describe('parseSignatureInput', () => {
  test('parses inner list and the four standard parameters', () => {
    const parsed = MessageSig.parseSignatureInput(
      'sig=("@method" "@target-uri" "content-type");created=1730999940;keyid="abc";alg="ed25519";nonce="def"',
    )
    expect(parsed.components).toEqual(['@method', '@target-uri', 'content-type'])
    expect(parsed.parameters).toEqual({
      alg: 'ed25519',
      created: 1730999940,
      keyid: 'abc',
      nonce: 'def',
    })
  })

  test('throws InvalidSignatureError when the requested label is missing', () => {
    expect(() => MessageSig.parseSignatureInput('other=()', 'sig')).toThrowErrorMatchingInlineSnapshot(
      `[MessageSig.InvalidSignatureError: Signature-Input missing label \`sig\`]`,
    )
  })

  test('skips unknown parameter names without failing', () => {
    const parsed = MessageSig.parseSignatureInput(
      'sig=("@method");created=1;keyid="k";extension-foo="bar"',
    )
    expect(parsed.parameters.keyid).toBe('k')
  })

  test('round-trips a value produced by sign()', () => {
    const headers = MessageSig.sign({
      components: ['@method', '@target-uri'],
      message: { headers: {}, method: 'POST', url: 'https://example.com/x' },
      parameters: { alg: 'ed25519', created: 1, keyid: 'k' },
      privateKey: Ed25519.createKeyPair().privateKey,
    })
    const parsed = MessageSig.parseSignatureInput(headers.signatureInput)
    expect(parsed.components).toEqual(['@method', '@target-uri'])
    expect(parsed.parameters.created).toBe(1)
    expect(parsed.parameters.keyid).toBe('k')
    expect(parsed.parameters.alg).toBe('ed25519')
  })
})

describe('parseSignature', () => {
  test('extracts the byte-sequence body for a label', () => {
    const value = `sig=:${Base64.fromBytes(new Uint8Array([1, 2, 3]))}:`
    const parsed = MessageSig.parseSignature(value)
    expect(Array.from(parsed.signature)).toEqual([1, 2, 3])
  })

  test('throws on missing wrapper colons', () => {
    expect(() => MessageSig.parseSignature('sig=invalid')).toThrowErrorMatchingInlineSnapshot(
      `[MessageSig.InvalidSignatureError: expected byte-sequence wrapper for label \`sig\`]`,
    )
  })
})

// Sanity check that our content-digest matches the byte-level
// shape RFC 9530 specifies (sha-256 followed by the bytes wrapped in
// `=:...:`).
test('contentDigest spec shape (RFC 9530)', () => {
  const body = '{"x":1}'
  const expected = `sha-256=:${Base64.fromBytes(sha256(Bytes.fromString(body)))}:`
  expect(MessageSig.contentDigest(body)).toBe(expected)
})
