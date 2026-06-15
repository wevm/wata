// Side-effect entrypoint that installs the runtime globals wata's crypto stack
// (`@noble/*`, `ox`) relies on but that React Native (Hermes) lacks. Import it
// once, before any other wata module evaluates:
//
//   import 'wata/react-native/polyfills'
//
// Requires `expo-crypto` (an optional peer dependency) to be installed; it is
// bundled in Expo Go, so no extra setup is needed there.
import * as Crypto from 'expo-crypto'

// React Native (Hermes) has no `crypto.getRandomValues` global. Install it from
// `expo-crypto` without clobbering an existing implementation (web, newer RN).
const globals: { crypto?: { getRandomValues?: typeof Crypto.getRandomValues } } = globalThis
globals.crypto ??= {}
globals.crypto.getRandomValues ??= Crypto.getRandomValues
