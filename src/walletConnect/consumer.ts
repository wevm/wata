/**
 * Consumer-side `walletConnect` transport -- connects a wata dapp to an
 * existing WalletConnect v2 wallet by wrapping
 * `@walletconnect/ethereum-provider`.
 *
 * `start()` initializes the provider (no namespaces required -- just
 * `projectId` + chains), surfaces the `wc:` pairing URI on `session.prompt`,
 * and -- when a `target` wallet deep link is supplied -- wraps the URI so the
 * link opens that specific wallet. `send()` maps one JSON-RPC request onto a
 * provider `request` carrying the CAIP-2 chain; the wallet's
 * `accountsChanged` / `chainChanged` events surface as notifications.
 *
 * @example
 * ```ts
 * import { Wata } from 'wata'
 * import { walletConnect } from 'wata/walletConnect'
 *
 * const session = await Wata.create({
 *   transports: [walletConnect({ projectId, chains: [1] })],
 * }).start()
 *
 * if (session.prompt) renderQrCode(session.prompt.uri)
 *
 * const { result } = await session.send({
 *   method: 'eth_sendTransaction',
 *   params: [tx],
 *   context: { chainId: 1 },
 * })
 * ```
 */

import * as Events from '../core/Events.js'
import * as Transport from '../core/Transport.js'
import * as Provider from './internal/Provider.js'
import * as Sign from './internal/Sign.js'

/** Pairing information carried by the consumer `'prompt'` event. */
export type Prompt = {
  /** WalletConnect pairing URI (`wc:...`), or a wallet deep link when `target` is set. */
  uri: string
}

/** Per-platform deep links (matches a directory item's `transports.walletConnect`). */
export type TargetPlatform = { native?: string | undefined; universal?: string | undefined }

/**
 * Wallet to hand the pairing URI to: per-platform deep links (e.g. a directory
 * item's `transports.walletConnect`) or an explicit `{ uri }`. Native scheme is
 * preferred over universal link, mobile over desktop.
 */
export type Target =
  | { desktop?: TargetPlatform | undefined; mobile?: TargetPlatform | undefined }
  | { uri: string }

/** Options accepted by {@link walletConnect}. */
export type Options = {
  /**
   * EVM chain ids offered to the wallet as `optionalChains` (CAIP-2
   * `eip155:*`). Must be non-empty; defaults to `[1]`.
   */
  chains?: readonly number[] | undefined
  /**
   * Override how the provider is created -- defaults to lazily importing
   * `@walletconnect/ethereum-provider`. Useful for tests or supplying a
   * pre-configured provider.
   */
  createProvider?: ((options: Provider.InitOptions) => Promise<Provider.Provider>) | undefined
  /** WalletConnect Cloud project id (required for relay auth). */
  projectId: string
  /**
   * Wallet to open -- pass a directory item's `transports.walletConnect` (its
   * `mobile` / `desktop` deep links) or an explicit `{ uri }`. Omit to surface
   * the raw `wc:` URI for a QR code. Overridable per call via `start({ target })`.
   */
  target?: Target | undefined
}

/** Start-time options: `target` is an optional per-session override. */
export type StartOptions = Transport.StartOptions<Options, Options, { optional: 'target' }>

/**
 * Create a consumer-side `walletConnect` transport. `start` additionally
 * accepts a {@link StartOptions} so the wallet `target` can be chosen per
 * session.
 *
 * @example
 * ```ts
 * import { walletConnect } from 'wata/walletConnect'
 *
 * const transport = walletConnect({ projectId, chains: [1, 10] })
 * ```
 */
export function walletConnect(
  options: Options,
): Transport.Transport<
  'consumer',
  'walletConnect',
  { prompt: Prompt; startOptions: StartOptions; startReturn: Prompt }
> {
  const { chains = [1], createProvider = Provider.init, projectId, target } = options

  const emitter = Events.create<Transport.EventMap<Transport.NoMessageMeta, Prompt>>()

  const state: { started: boolean } = { started: false }
  let provider: Provider.Provider | undefined
  let prompt: Prompt | undefined
  let startPromise: Promise<Prompt> | undefined
  let connecting: Promise<void> | undefined
  let listeners: Array<() => void> = []

  function wireEvents(p: Provider.Provider): void {
    const onAccountsChanged = (accounts: readonly string[]) =>
      emitter.emit('message', Sign.notificationEnvelope('accountsChanged', [accounts]))
    const onChainChanged = (chainId: number | string) =>
      emitter.emit('message', Sign.notificationEnvelope('chainChanged', [chainId]))
    const onDisconnect = () => void close()
    p.on('accountsChanged', onAccountsChanged)
    p.on('chainChanged', onChainChanged)
    p.on('disconnect', onDisconnect)
    listeners = [
      () => p.removeListener('accountsChanged', onAccountsChanged),
      () => p.removeListener('chainChanged', onChainChanged),
      () => p.removeListener('disconnect', onDisconnect),
    ]
  }

  async function close(cause?: Error): Promise<void> {
    if (!state.started && !provider) return
    state.started = false
    connecting = undefined
    for (const off of listeners) off()
    listeners = []
    const p = provider
    provider = undefined
    prompt = undefined
    try {
      await p?.disconnect()
    } catch {
      // Wallet may already be gone; the close event below is what matters.
    }
    emitter.emit('close', cause)
  }

  async function start(options: StartOptions = {}): Promise<Prompt> {
    if (state.started && prompt) return prompt
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        if (chains.length === 0)
          throw new Transport.TransportError('`walletConnect` requires at least one chain')
        const target_resolved = resolveTarget(options.target ?? target)
        const p = await createProvider({ optionalChains: chains, projectId, showQrModal: false })
        provider = p

        // Resolve `start()` as soon as the pairing URI is ready (surfaced as
        // the prompt) -- the wallet approves out of band; `connect()` settles
        // then, and `send()` awaits it.
        let resolveReady!: (value: Prompt) => void
        let rejectReady!: (cause: Error) => void
        const ready = new Promise<Prompt>((resolve, reject) => {
          resolveReady = resolve
          rejectReady = reject
        })
        const onDisplayUri = (uri: string) => {
          prompt = { uri: Provider.deepLink(target_resolved, uri) }
          emitter.emit('prompt', prompt)
          resolveReady(prompt)
        }
        p.on('display_uri', onDisplayUri)
        wireEvents(p)

        connecting = p.connect()
        void connecting.then(
          () => p.removeListener('display_uri', onDisplayUri),
          (cause) => {
            rejectReady(cause as Error)
            void close(cause as Error)
          },
        )
        const value = await ready
        state.started = true
        return value
      } finally {
        startPromise = undefined
      }
    })()
    return startPromise
  }

  return {
    capabilities: {
      notifications: { consumer: false, host: true },
      requests: { consumer: true, host: false },
    },
    close,
    exchange: 'ongoing',
    name: 'walletConnect',
    on: emitter.on,
    role: 'consumer',
    async send(envelope) {
      if (!state.started) await start()
      if (connecting) await connecting
      if (!provider) throw new Transport.ClosedError('walletConnect session is not started')
      const request = Sign.toProviderRequest(envelope)
      const chain = request.chainId !== undefined ? Sign.toCaip2(request.chainId) : undefined
      void provider
        .request({ method: request.method, params: request.params }, chain)
        .then((result) => emitter.emit('message', Sign.successEnvelope(request.id, result)))
        .catch((error) => emitter.emit('message', Sign.errorEnvelope(request.id, error)))
    },
    start,
  }
}

/** Resolve a {@link Target} to a single deep-link string (or `undefined`). */
function resolveTarget(target: Target | undefined): string | undefined {
  if (!target) return undefined
  if ('uri' in target) return target.uri
  const link = (platform: TargetPlatform | undefined) => platform?.native ?? platform?.universal
  return link(target.mobile) ?? link(target.desktop)
}
