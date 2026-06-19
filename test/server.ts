// Real HTTP server helper for tests: listens on an ephemeral loopback port
// from a web-standard fetch handler, records request URLs, and closes itself
// when the running test finishes (`onTestFinished`) -- no manual lifecycle.

import { createServer } from 'node:http'
import { onTestFinished } from 'vp/test'
import { Server } from 'wata/server'

export type TestServer = {
  /** Parsed URLs of every request received, in order. */
  requests: URL[]
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  url: string
}

/**
 * Start a real HTTP server backed by a web-standard fetch `handler`. Records
 * each request URL on `requests`; auto-closed when the current test finishes.
 */
export async function serve(
  handler: (request: Request) => Promise<Response> | Response,
): Promise<TestServer> {
  const requests: URL[] = []
  const fetch = async (request: Request): Promise<Response> => {
    requests.push(new URL(request.url))
    return handler(request)
  }
  const server = createServer(Server.node({ fetch }).listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { requests, url: `http://127.0.0.1:${port}` }
}
