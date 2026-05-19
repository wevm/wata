const role = process.env.EXPO_PUBLIC_MOBILE_LINK_ROLE === 'host' ? 'host' : 'consumer'

export default {
  expo: {
    android: {
      package:
        role === 'host'
          ? 'com.wata.example.mobilelink.ironbank'
          : 'com.wata.example.mobilelink.spendlet',
    },
    ios: {
      bundleIdentifier:
        role === 'host'
          ? 'com.wata.example.mobilelink.ironbank'
          : 'com.wata.example.mobilelink.spendlet',
    },
    name: role === 'host' ? 'Ironbank' : 'Spendlet',
    platforms: ['ios', 'android'],
    scheme: role === 'host' ? 'example-ironbank' : 'example-spendlet',
    slug: role === 'host' ? 'example-mobile-link-ironbank' : 'example-mobile-link-spendlet',
    version: '1.0.0',
  },
}
