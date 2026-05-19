const role = process.env.EXPO_PUBLIC_MOBILE_LINK_ROLE === 'host' ? 'host' : 'consumer'

export default {
  expo: {
    name: role === 'host' ? 'Wata Wallet' : 'Wata Consumer',
    platforms: ['ios', 'android'],
    scheme: role === 'host' ? 'examplewallet' : 'exampleapp',
    slug: role === 'host' ? 'wata-mobile-link-wallet' : 'wata-mobile-link-consumer',
    version: '1.0.0',
  },
}
