/**
 * Discovery worker for the mobile consumer — publishes `consumer.json`.
 *
 * Hosts fetch this document to verify the consumer: `mobileWebAuth` checks the
 * registered callback URI, `mobileLink` checks the return url. Reproduces the
 * production HTTPS origin on `http://localhost:8789`.
 */

import { Wata, mobileLink, mobileWebAuth } from 'wata'

import { consumerOrigin, mobileLinkReturnUrl, mobileWebAuthCallback } from './src/config.js'

// `consumer.json` describes the consumer itself (callback URI + return url), so
// it is published independently of any particular host — the host to connect to
// is chosen at runtime from the directory.
const consumer = Wata.create({
  baseUrl: consumerOrigin,
  meta: { name: 'Wata App' },
  transports: [
    mobileWebAuth({ callback: mobileWebAuthCallback }),
    mobileLink({ returnUrl: mobileLinkReturnUrl }),
  ],
})

const fetch = consumer.fetch as never as typeof globalThis.fetch

export default {
  fetch(request: Request) {
    return fetch(request)
  },
}
