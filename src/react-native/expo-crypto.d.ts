// Ambient shim for the optional `expo-crypto` peer dependency. The `polyfills`
// entrypoint only needs `getRandomValues`, and the `tsconfig.base.json` `paths`
// map resolves `expo-crypto` here when compiling wata's own source — so its real
// types (which pull Expo/React Native global augmentations) never leak into the
// node-flavored source graph. Consumers that install `expo-crypto` get its real,
// richer types.
export function getRandomValues<T extends ArrayBufferView>(typedArray: T): T
