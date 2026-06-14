import * as Crypto from 'expo-crypto'

const globals: { crypto?: { getRandomValues?: typeof Crypto.getRandomValues } } = globalThis
globals.crypto ??= {}
globals.crypto.getRandomValues ??= Crypto.getRandomValues
