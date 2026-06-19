import { describe, expect, test } from 'vp/test'
import { Wata } from 'wata'
import { walletConnect } from 'wata/walletConnect'

import type { Provider } from './internal/Provider.js'

type RequestHandler = (
  args: { method: string; params?: unknown },
  chain?: string,
) => Promise<unknown>

/** A scriptable fake of `@walletconnect/ethereum-provider`. */
function fakeProvider(options: { request?: RequestHandler; uri?: string } = {}) {
  const listeners: Record<string, Array<(payload: any) => void>> = {}
  const calls: Array<{ args: { method: string; params?: unknown }; chain?: string | undefined }> =
    []
  let disconnected = false

  function fire(event: string, payload: unknown) {
    for (const listener of (listeners[event] ?? []).slice()) listener(payload)
  }

  const provider: Provider = {
    async connect() {
      fire('display_uri', options.uri ?? 'wc:topic@2?relay-protocol=irn&symKey=abc')
    },
    async disconnect() {
      disconnected = true
    },
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener)
    },
    removeListener(event, listener) {
      listeners[event] = (listeners[event] ?? []).filter((entry) => entry !== listener)
    },
    request(args, chain) {
      calls.push({ args, chain })
      return options.request ? options.request(args, chain) : Promise.resolve(null)
    },
  }

  return {
    calls,
    createProvider: async () => provider,
    get disconnected() {
      return disconnected
    },
    fire,
  }
}

describe('walletConnect transport', () => {
  test('surfaces the raw wc: URI on the prompt when no target is set', async () => {
    const fake = fakeProvider({ uri: 'wc:deadbeef@2?relay-protocol=irn&symKey=abc' })
    const transport = walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })
    const prompt = await transport.start()
    expect(prompt.uri).toBe('wc:deadbeef@2?relay-protocol=irn&symKey=abc')
  })

  test('wraps an explicit `{ uri }` target into a deep link', async () => {
    const fake = fakeProvider({ uri: 'wc:deadbeef@2' })
    const transport = walletConnect({
      createProvider: fake.createProvider,
      projectId: 'pid',
      target: { uri: 'metamask://' },
    })
    const prompt = await transport.start()
    expect(prompt.uri).toBe(`metamask://wc?uri=${encodeURIComponent('wc:deadbeef@2')}`)
  })

  test('resolves a wallet binding, preferring the native scheme', async () => {
    const fake = fakeProvider({ uri: 'wc:deadbeef@2' })
    const transport = walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })
    const prompt = await transport.start({
      target: { mobile: { native: 'metamask://', universal: 'https://metamask.app.link' } },
    })
    expect(prompt.uri).toBe(`metamask://wc?uri=${encodeURIComponent('wc:deadbeef@2')}`)
  })

  test('falls back to the universal link, then desktop', async () => {
    const fake = fakeProvider({ uri: 'wc:deadbeef@2' })
    const transport = walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })
    const prompt = await transport.start({
      target: { desktop: { universal: 'https://app.example' } },
    })
    expect(prompt.uri).toBe(`https://app.example/wc?uri=${encodeURIComponent('wc:deadbeef@2')}`)
  })

  test('advertises consumer-request / host-notification capabilities', () => {
    const fake = fakeProvider()
    const transport = walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })
    expect(transport.capabilities).toEqual({
      notifications: { consumer: false, host: true },
      requests: { consumer: true, host: false },
    })
  })

  test('disconnects the provider on close', async () => {
    const fake = fakeProvider()
    const transport = walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })
    await transport.start()
    await transport.close()
    expect(fake.disconnected).toBe(true)
  })
})

describe('walletConnect through Wata.create', () => {
  test('maps send() to a provider request carrying the CAIP-2 chain', async () => {
    const fake = fakeProvider({ request: async () => '0xresult' })
    const wata = Wata.create({
      transports: [
        walletConnect({ chains: [1, 10], createProvider: fake.createProvider, projectId: 'pid' }),
      ],
    })
    const session = await wata.start()
    const { result } = await session.send({
      context: { chainId: 10 },
      method: 'eth_sendTransaction',
      params: [{ to: '0xabc' }],
    })
    expect(result).toBe('0xresult')
    expect(fake.calls).toEqual([
      { args: { method: 'eth_sendTransaction', params: [{ to: '0xabc' }] }, chain: 'eip155:10' },
    ])
  })

  test('sends with no chain when context.chainId is absent', async () => {
    const fake = fakeProvider({ request: async () => '0x1' })
    const wata = Wata.create({
      transports: [walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })],
    })
    const session = await wata.start()
    await session.send({ method: 'eth_chainId', params: [] })
    expect(fake.calls[0]?.chain).toBeUndefined()
  })

  test('rejects send() with the wallet error', async () => {
    const fake = fakeProvider({
      request: async () => {
        throw { code: 4001, message: 'User rejected' }
      },
    })
    const wata = Wata.create({
      transports: [walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })],
    })
    const session = await wata.start()
    await expect(
      session.send({ context: { chainId: 1 }, method: 'eth_sendTransaction', params: [{}] }),
    ).rejects.toThrow(/User rejected/)
  })

  test('surfaces accountsChanged / chainChanged as notifications', async () => {
    const fake = fakeProvider()
    const wata = Wata.create({
      transports: [walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })],
    })
    const session = await wata.start()
    const events: Array<{ method: string; params: unknown }> = []
    session.onNotification((event) => events.push({ method: event.method, params: event.params }))

    fake.fire('accountsChanged', ['0xabc'])
    fake.fire('chainChanged', '0xa')

    expect(events).toEqual([
      { method: 'accountsChanged', params: [['0xabc']] },
      { method: 'chainChanged', params: ['0xa'] },
    ])
  })

  test('closes the session when the wallet disconnects', async () => {
    const fake = fakeProvider()
    const wata = Wata.create({
      transports: [walletConnect({ createProvider: fake.createProvider, projectId: 'pid' })],
    })
    const session = await wata.start()
    await session.ready
    let closed = false
    session.onClose(() => {
      closed = true
    })
    fake.fire('disconnect', undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toBe(true)
  })
})
