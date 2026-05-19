import * as ExpoCrypto from 'expo-crypto'

import '../../../src/core/internal/messageEvent.js'

if (!globalThis.crypto)
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {},
    writable: true,
  })

if (typeof globalThis.crypto.getRandomValues !== 'function')
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    configurable: true,
    value: ExpoCrypto.getRandomValues.bind(ExpoCrypto),
    writable: true,
  })
