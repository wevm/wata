import { Identity, Wata, mobileLink } from 'wata/host'

import { hostIdentityPrivateKey, hostOrigin, hostScheme } from './src/config.js'

const host = Wata.create({
  baseUrl: hostOrigin,
  identity: Identity.fromPrivateKey(hostIdentityPrivateKey),
  meta: { name: 'Wata Wallet' },
  transports: [mobileLink({ scheme: hostScheme })],
})

const started = host.mobileLink.start()
const fetch = host.fetch as never as typeof globalThis.fetch

export default {
  async fetch(request: Request) {
    await started
    return await fetch(request)
  },
}
