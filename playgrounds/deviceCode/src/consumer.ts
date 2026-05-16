/**
 * Device-code playground consumer.
 *
 * Runs a `@clack/prompts`-driven CLI that drives the uRPC `device-code`
 * transport against the host playground. Prints the verification URL +
 * user code, then polls `/token` until the user approves the request
 * in their browser.
 *
 * Run after starting `host.ts`:
 * ```sh
 * pnpm --filter device-code-playground dev:consumer
 * ```
 */

import * as Clack from '@clack/prompts'
import { Wata, deviceCode } from 'wata'

const baseUrl = process.env['BASE_URL'] ?? 'http://localhost:4747'

Clack.intro('uRPC device-code consumer')

const method = await Clack.select({
  message: 'Pick a method to call',
  options: [
    { value: 'ping', label: 'ping (no params)' },
    { value: 'echo', label: 'echo (params: { hello: "world" })' },
  ],
})
if (Clack.isCancel(method)) {
  Clack.cancel('cancelled')
  process.exit(0)
}

const wata = Wata.create({
  transport: deviceCode({
    meta: {
      name: 'Acme CLI',
      description: 'uRPC device-code playground consumer',
      icon: 'https://api.dicebear.com/9.x/identicon/svg?seed=acme-cli',
    },
    onPrompt({ userCode, verificationUri, verificationUriFull }) {
      Clack.note(
        `${verificationUri}\nuser_code: ${userCode}` +
          (verificationUriFull ? `\nor visit: ${verificationUriFull}` : ''),
        'Open this URL in your browser to approve',
      )
    },
    pollingInterval: 1000,
    url: `${baseUrl}/auth/device`,
  }),
})

const params = method === 'echo' ? [{ hello: 'world' }] : []

const spinner = Clack.spinner()
spinner.start('waiting for approval...')

try {
  const response = await wata.send({ method: method as string, params: params as never })
  spinner.stop('approved')
  Clack.outro(`response: ${JSON.stringify(response.result)}`)
} catch (cause) {
  spinner.stop('failed')
  Clack.outro(`error: ${(cause as Error).name}: ${(cause as Error).message}`)
  process.exit(1)
}
