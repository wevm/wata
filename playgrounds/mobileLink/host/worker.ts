import { Identity, Wata, mobileLink } from 'wata/host'

import { hostIdentityPrivateKey, hostOrigin, hostScheme } from './src/config.js'

const host = Wata.create({
  baseUrl: hostOrigin,
  identity: Identity.fromPrivateKey(hostIdentityPrivateKey),
  meta: { name: 'Wata Wallet' },
  transports: [mobileLink({ scheme: hostScheme })],
})

export default { fetch: host.fetch }
