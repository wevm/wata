/**
 * CLI consumer — directory-driven.
 *
 * Queries the directory (`examples/directory`) for wallets, picks one, fetches
 * that origin's `host.json`, and chooses a transport from what it advertises:
 *
 *   • a `device-code` binding (web wallet) → `deviceCode` (prints a short
 *     `user_code` to approve in a browser)
 *   • otherwise (mobile wallet) → `relay` (prints a pairing QR/link to scan
 *     from the wallet)
 *
 *   pnpm dev                  # connect to the first wallet in the directory
 *   pnpm dev --wallet <name>  # connect to a wallet whose id/name matches <name>
 */

import qrcode from 'qrcode-terminal'
import { Discovery, Wata, deviceCode, relay } from 'wata'

import { directoryUrl, relayUrl } from './config.js'

type Wallet = { id: string; name: string; origin: string }

const filter = process.argv.includes('--wallet')
  ? process.argv[process.argv.indexOf('--wallet') + 1]
  : undefined

const wallets = await fetchWallets()
if (wallets.length === 0) {
  console.error('no wallets in the directory (is `examples/directory` running?)')
  process.exit(1)
}

console.log('directory wallets:')
for (const wallet of wallets) console.log(`  - ${wallet.name} (${wallet.id})`)

const wallet = filter
  ? wallets.find((w) => `${w.id} ${w.name}`.toLowerCase().includes(filter.toLowerCase()))
  : wallets[0]
if (!wallet) {
  console.error(`no wallet matches --wallet "${filter}"`)
  process.exit(1)
}

console.log(`\nselected: ${wallet.name}`)

const document = await Discovery.fetchHost(wallet.origin)
const deviceCodeBinding = document.transports['device-code']

const wata = Wata.create({
  transports: [
    deviceCode({ pollingInterval: 1_000 }),
    // `allowPrivateNetwork` permits an http relay on a LAN address so a phone
    // can reach the dev machine. Production relays are HTTPS and need no opt-in.
    relay({ allowPrivateNetwork: true, url: relayUrl }),
  ],
})

// Web wallet → device-code (derive the base url from the published binding);
// mobile wallet → relay.
const session = deviceCodeBinding
  ? await wata.deviceCode.start({ url: deviceCodeBinding.register_url.replace(/\/register$/, '') })
  : await wata.relay.start()

session.onClose((cause) => console.log(`closed${cause ? `: ${cause.message}` : ''}`))
session.onError((error) => console.log(`error: ${error.message}`))

session.onPrompt((prompt) => {
  if (prompt.transport === 'deviceCode') {
    console.log(`\nopen ${prompt.verificationUriFull}`)
    console.log(`user_code: ${prompt.userCode}\n`)
  } else if (prompt.transport === 'relay') {
    console.log('\nscan this from the mobile wallet (or paste the link):\n')
    qrcode.generate(prompt.uri, { small: true })
    console.log(`\n${prompt.uri}\n`)
  }
})

console.log(`connecting to ${wallet.name}…`)

const { result } = await session.send({
  method: 'ping',
  params: [{ message: 'hello from CLI' }],
})

console.log('result:', result)
await session.close()

/** Query the directory for indexed wallets. */
async function fetchWallets(): Promise<readonly Wallet[]> {
  const response = await fetch(`${directoryUrl}/v1/hosts`)
  if (!response.ok) throw new Error(`directory responded ${response.status}`)
  const body = (await response.json()) as { items: readonly Wallet[] }
  return body.items
}
