import { Wata, mobileLink } from 'wata'

import { consumerOrigin, consumerReturnUrl } from './src/config.js'

const consumer = Wata.create({
  baseUrl: consumerOrigin,
  meta: { name: 'Wata App' },
  transports: [mobileLink({ returnUrl: consumerReturnUrl })],
})

export default { fetch: consumer.fetch }
