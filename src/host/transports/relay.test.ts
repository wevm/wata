import { describe, expect, test } from 'vp/test'
import { relay } from 'wata/host'

const uri =
  'urpc://?consumer_pubkey=ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8&pairing_secret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE&relay=https%3A%2F%2Frelay.example&version=1'

describe('relay', () => {
  test('constructs without a uri', () => {
    const transport = relay()
    expect(transport.name).toBe('relay')
    expect(transport.role).toBe('host')
  })

  test('validates a construction-time uri eagerly', () => {
    expect(() => relay({ uri: 'not-a-relay-uri' })).toThrowErrorMatchingInlineSnapshot(
      `[Relay.InvalidUriError: value is not a valid relay pairing uri]`,
    )
  })

  test('accepts a valid construction-time uri', () => {
    expect(() => relay({ uri: uri })).not.toThrow()
  })

  test('rejects a private-network relay uri by default', () => {
    const privateUri = uri.replace(
      'relay=https%3A%2F%2Frelay.example',
      'relay=http%3A%2F%2F169.254.169.254',
    )
    expect(() => relay({ uri: privateUri })).toThrowErrorMatchingInlineSnapshot(
      `[Relay.InvalidUriError: value is not a valid relay pairing uri]`,
    )
  })

  test('accepts a private-network relay uri with `allowPrivateNetwork`', () => {
    const privateUri = uri.replace(
      'relay=https%3A%2F%2Frelay.example',
      'relay=http%3A%2F%2F169.254.169.254',
    )
    expect(() => relay({ allowPrivateNetwork: true, uri: privateUri })).not.toThrow()
  })

  test('validates a start-time uri eagerly', async () => {
    const transport = relay()
    await expect(
      transport.start({ uri: 'not-a-relay-uri' }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Relay.InvalidUriError: value is not a valid relay pairing uri]`,
    )
  })

  test('closing before a uri arrives rejects an in-flight start', async () => {
    const transport = relay()
    const started = transport.start()
    await transport.close()
    await expect(started).rejects.toThrowError()
  })
})
