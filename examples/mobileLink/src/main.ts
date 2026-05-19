import { Wata, mobileLink } from 'wata'
import { Wata as HostWata, mobileLink as hostMobileLink } from 'wata/host'

type AccessRequest = {
  appName: string
  permissions: string[]
}

const hostUrl = 'https://ironbank.example/auth/mobile-link'
const callbackUrl = 'spendlet://callback'
const privateKey = `0x${'11'.repeat(32)}` as `0x${string}`
const publicKey = '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc'
const permissions = ['Account balance', 'Recent transactions', 'Account holder name']

const spendletStatus = document.querySelector<HTMLParagraphElement>('#spendlet-status')!
const ironbankStatus = document.querySelector<HTMLParagraphElement>('#ironbank-status')!
const ironbankRequest = document.querySelector<HTMLDivElement>('#ironbank-request')!
const spendletResult = document.querySelector<HTMLDivElement>('#spendlet-result')!
const connect = document.querySelector<HTMLButtonElement>('#connect')!
const allow = document.querySelector<HTMLButtonElement>('#allow')!
const deny = document.querySelector<HTMLButtonElement>('#deny')!

let pending: HostWata.SchemaRequestEvent<undefined> | undefined
let request: AccessRequest | undefined

const open = async (url: string) => {
  if (url.startsWith(hostUrl)) await ironbank.mobileLink.handle(url)
  else await spendlet.mobileLink.handle(url)
}

const spendlet = Wata.create({
  transports: [
    mobileLink({
      callbackUrl,
      identity: { deepLinkUrl: hostUrl, publicKey },
      open,
    }),
  ],
})

const ironbank = HostWata.create({
  privateKey,
  transports: [
    hostMobileLink({
      open,
      scheme: 'ironbank',
      universalLink: hostUrl,
    }),
  ],
})

const renderIronbank = () => {
  allow.disabled = !pending
  deny.disabled = !pending
  ironbankRequest.innerHTML = request
    ? `<h3>${request.appName} wants to access:</h3><ul>${request.permissions
        .map((permission) => `<li>${permission}</li>`)
        .join('')}</ul>`
    : '<p>No request yet. Start in Spendlet.</p>'
}

ironbank.on('request', (event) => {
  if (event.method !== 'authorizeAccountAccess') return undefined
  const params = Array.isArray(event.params) ? event.params : []
  const accessRequest = params[0] as AccessRequest | undefined
  if (!accessRequest) return undefined
  pending = event
  request = accessRequest
  ironbankStatus.textContent = 'Review this request'
  renderIronbank()
  return undefined
})

connect.addEventListener('click', async () => {
  connect.disabled = true
  spendletStatus.textContent = 'Opening Ironbank...'
  spendletResult.textContent = ''
  try {
    const { result } = await spendlet.send({
      method: 'authorizeAccountAccess',
      params: [{ appName: 'Spendlet', permissions }],
    })
    const response = result as { accountName: string; message: string }
    spendletStatus.textContent = 'Connected to Ironbank'
    spendletResult.textContent = `${response.message}\nAccount: ${response.accountName}`
  } catch {
    spendletStatus.textContent = 'Ironbank was not connected'
  } finally {
    connect.disabled = false
  }
})

allow.addEventListener('click', async () => {
  if (!pending || !request) return
  const event = pending
  pending = undefined
  ironbankStatus.textContent = 'Access approved'
  renderIronbank()
  await event.respond({
    accountName: 'Ironbank Everyday',
    approved: true,
    at: new Date().toISOString(),
    message: `${request.appName} can now view your Ironbank account.`,
    permissions: request.permissions,
  })
})

deny.addEventListener('click', async () => {
  if (!pending) return
  const event = pending
  pending = undefined
  ironbankStatus.textContent = 'Access denied'
  renderIronbank()
  await event.reject({ code: -32000, message: 'Access denied' })
})

renderIronbank()
