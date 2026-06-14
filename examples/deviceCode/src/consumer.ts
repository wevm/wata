/**
 * Minimal consumer-side example for the `deviceCode` transport.
 *
 * Opens a `Wata` session against the host server, prints the
 * verification URL + user code when prompted, then polls until
 * the user approves the request in their browser.
 */

import { Wata, deviceCode } from 'wata'

const baseUrl = 'http://localhost:4747'

const wata = Wata.create({
  transports: [
    deviceCode({
      pollingInterval: 1_000,
      url: `${baseUrl}/auth/device`,
    }),
  ],
})

wata.on('prompt', ({ userCode, verificationUriFull }) => {
  console.log(`open ${verificationUriFull}`)
  console.log(`user_code: ${userCode}`)
})

const { result } = await wata.send({
  method: 'ping',
  params: [{ message: 'hello from consumer' }],
})

console.log('result:', result)
