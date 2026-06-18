import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vp/test'
import { Wata, loopback } from 'wata'
import { Wata as HostWata } from 'wata/host'
import { useSession } from 'wata/react'

// React's `act` requires this flag in a test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

/** Render `useSession(wata)` and expose its latest result via a getter. */
async function render(wata: Parameters<typeof useSession>[0]) {
  type Result = ReturnType<typeof useSession>
  let result: Result = undefined as never
  function Harness() {
    result = useSession(wata)
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Harness))
  })
  return {
    get current() {
      return result
    },
    unmount: () => act(async () => root.unmount()),
  }
}

describe('useSession', () => {
  test('starts the session, sends, receives notifications, and closes', async () => {
    const { consumer, host } = loopback()

    const hostSession = await HostWata.create({ transports: [host] }).start()
    hostSession.onRequest(async (event) => {
      if (event.method === 'ping') await event.respond({ ok: true })
    })

    const wata = Wata.create({ transports: [consumer] })

    const notifications: unknown[] = []
    type Result = ReturnType<typeof useSession<typeof wata>>
    let result: Result = undefined as never
    function Harness() {
      result = useSession(wata, { onNotification: (event) => notifications.push(event) })
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(createElement(Harness))
    })

    // Lazy by default — idle until `start()`.
    expect(result.status).toBe('idle')
    expect(result.session).toBeUndefined()

    let sendResult: unknown
    await act(async () => {
      const session = await result.start()
      sendResult = (await session.send({ method: 'ping', params: [] })).result
    })

    expect(result.status).toBe('open')
    expect(result.session).toBeDefined()
    expect(sendResult).toEqual({ ok: true })

    await act(async () => {
      await hostSession.notify({ method: 'tick', params: [{ n: 1 }] })
    })
    expect(notifications).toMatchObject([{ method: 'tick', params: [{ n: 1 }] }])

    await act(async () => {
      await result.close()
    })
    expect(result.status).toBe('closed')
    expect(result.session).toBeUndefined()

    await act(async () => root.unmount())
  })

  test('start() is idempotent while the session is open', async () => {
    const { consumer, host } = loopback()
    await HostWata.create({ transports: [host] }).start()

    const wata = Wata.create({ transports: [consumer] })
    const harness = await render(wata)

    let first: unknown
    let second: unknown
    await act(async () => {
      first = await harness.current.start()
      second = await harness.current.start()
    })
    expect(first).toBe(second)

    await harness.unmount()
  })

  test('host: onRequest fires and respond resolves the consumer send', async () => {
    const { consumer, host } = loopback()
    const hostWata = HostWata.create({ transports: [host] })

    const requests: { method: string }[] = []
    type Result = ReturnType<typeof useSession>
    let result: Result = undefined as never
    function Harness() {
      result = useSession(hostWata, {
        onRequest: (event) => {
          requests.push({ method: event.method })
          void event.respond({ ok: true })
        },
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(createElement(Harness))
    })
    await act(async () => {
      await result.start()
    })
    expect(result.status).toBe('open')

    const consumerSession = await Wata.create({ transports: [consumer] }).start()
    let sent: unknown
    await act(async () => {
      sent = (await consumerSession.send({ method: 'ping', params: [] })).result
    })

    expect(requests).toEqual([{ method: 'ping' }])
    expect(sent).toEqual({ ok: true })

    await act(async () => root.unmount())
  })
})
