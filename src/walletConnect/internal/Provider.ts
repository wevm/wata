/**
 * Thin lifecycle wrapper over the optional `@walletconnect/ethereum-provider`
 * peer. Owns the lazy import -- the heavy WC dependency loads only when a
 * `walletConnect()` session starts -- and the wallet deep-link composer.
 *
 * wata drives only the narrow {@link Provider} surface below; the SDK import
 * is dynamic and cast at the boundary, so the entrypoint carries none of the
 * SDK's type graph and is import-safe without the optional peer present.
 */

/** Subset of `@walletconnect/ethereum-provider` the transport drives. */
export type Provider = {
  connect(options?: unknown): Promise<void>
  disconnect(): Promise<void>
  on(event: string, listener: (payload: any) => void): void
  removeListener(event: string, listener: (payload: any) => void): void
  request(args: { method: string; params?: unknown }, chain?: string): Promise<unknown>
}

/** Options forwarded to `EthereumProvider.init` (subset wata sets). */
export type InitOptions = {
  optionalChains?: readonly number[] | undefined
  projectId: string
  showQrModal?: boolean | undefined
}

type ProviderModule = {
  EthereumProvider: { init(options: InitOptions): Promise<Provider> }
}

/**
 * Lazily import `@walletconnect/ethereum-provider` and initialize a provider.
 * Throws a helpful error when the optional peer is not installed.
 */
export async function init(options: InitOptions): Promise<Provider> {
  let module: ProviderModule
  try {
    module = (await import('@walletconnect/ethereum-provider')) as unknown as ProviderModule
  } catch (cause) {
    throw new Error(
      '`@walletconnect/ethereum-provider` is required by `wata/walletConnect`; install it in your app.',
      { cause: cause as Error },
    )
  }
  return module.EthereumProvider.init(options)
}

/**
 * Compose a wallet deep link that hands the `wc:` pairing URI to a chosen
 * wallet. `target` is a native scheme (`metamask://`) or a universal link
 * (`https://metamask.app.link`) from the WalletConnect directory; native is
 * preferred on mobile (universal links may bounce through a browser). With no
 * `target`, returns `uri` unchanged -- the universal link.
 */
export function deepLink(target: string | undefined, uri: string): string {
  if (!target) return uri
  const encoded = encodeURIComponent(uri)
  if (target.startsWith('http://') || target.startsWith('https://'))
    return `${target.replace(/\/+$/, '')}/wc?uri=${encoded}`
  const root = target.includes('://') ? target : `${target}://`
  return `${root}wc?uri=${encoded}`
}
