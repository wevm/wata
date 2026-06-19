import * as Linking from 'expo-linking'
import { Wata, mobileLink, mobileWebAuth } from 'wata'

import { consumerOrigin, mobileLinkReturnUrl, mobileWebAuthCallback } from './config.js'

/**
 * Consumer config carrying both mobile transports. `mobileWebAuth` reaches the
 * web host; `mobileLink` reaches the mobile host. The published `consumer.json`
 * advertises the callback URI + return url so each host can verify them.
 */
export const wata = Wata.create({
  baseUrl: consumerOrigin,
  meta: { name: 'Wata App' },
  transports: [
    mobileWebAuth({ callback: mobileWebAuthCallback }),
    mobileLink({
      async openLink(url) {
        await Linking.openURL(url)
      },
      returnUrl: mobileLinkReturnUrl,
    }),
  ],
})
