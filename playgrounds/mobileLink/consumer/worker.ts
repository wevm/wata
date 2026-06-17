import { Wata, mobileLink } from 'wata'

import { consumerOrigin, consumerReturnUrl, hostOrigin } from './src/config.js'

const consumer = Wata.create({
  baseUrl: consumerOrigin,
  meta: { name: 'Wata App' },
  transports: [mobileLink({ returnUrl: consumerReturnUrl })],
})

const started = consumer.mobileLink.start({ host: hostOrigin })
const fetch = consumer.fetch as never as typeof globalThis.fetch

export default {
  async fetch(request: Request) {
    await started
    return await fetch(request)
  },
}
