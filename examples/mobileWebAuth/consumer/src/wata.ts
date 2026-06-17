import { Wata, mobileWebAuth } from 'wata'

import { callback, consumerOrigin } from './config.js'

export const wata = Wata.create({
  baseUrl: consumerOrigin,
  meta: { name: 'Example App' },
  transports: [mobileWebAuth({ callback })],
})
