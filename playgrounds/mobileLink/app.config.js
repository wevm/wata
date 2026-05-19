const role = process.env.EXPO_PUBLIC_MOBILE_LINK_ROLE === 'host' ? 'host' : 'consumer'

export default {
  expo: {
    android: {
      package: role === 'host' ? 'com.wata.mobilelink.ironbank' : 'com.wata.mobilelink.spendlet',
    },
    ios: {
      bundleIdentifier:
        role === 'host' ? 'com.wata.mobilelink.ironbank' : 'com.wata.mobilelink.spendlet',
    },
    name: role === 'host' ? 'Ironbank' : 'Spendlet',
    platforms: ['ios', 'android'],
    scheme: role === 'host' ? 'ironbank' : 'spendlet',
    slug: role === 'host' ? 'wata-mobile-link-ironbank' : 'wata-mobile-link-spendlet',
    version: '1.0.0',
  },
}
