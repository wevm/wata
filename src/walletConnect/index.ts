// wata/walletConnect: WalletConnect v2 compatibility entrypoint.
//
// Connects a wata dapp (consumer) to existing WalletConnect wallets via the
// `walletConnect` transport. `@walletconnect/ethereum-provider` is an optional
// peer dependency. The WalletConnect directory source lives on the core
// `Directory` (`Directory.walletConnectSource`, also selected by
// `Directory.query({ transports: ['walletConnect'] })`).

export { walletConnect } from './consumer.js'
export type { Options, Prompt, StartOptions, Target, TargetPlatform } from './consumer.js'
