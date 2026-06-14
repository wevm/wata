import * as Crypto from 'expo-crypto'

// React Native (Hermes) has no `crypto.getRandomValues` global, but wata's
// crypto stack (`@noble/*`, `ox`) needs it. `expo-crypto` is bundled in
// Expo Go, so polyfill from it before any wata module evaluates.
const globals: { crypto?: { getRandomValues?: typeof Crypto.getRandomValues } } = globalThis
globals.crypto ??= {}
globals.crypto.getRandomValues ??= Crypto.getRandomValues
