import * as Crypto from 'expo-crypto'

const globals = globalThis as { crypto?: { getRandomValues?: typeof Crypto.getRandomValues } }
globals.crypto ??= {}
globals.crypto.getRandomValues ??= Crypto.getRandomValues
