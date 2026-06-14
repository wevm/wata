/** Ensures a path string starts with `/`. */
export function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`
}

/** Returns true for HTTPS, loopback HTTP, or reverse-DNS private-use callback URIs. */
export function isAllowedAppCallback(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (isLoopbackHttp(url)) return true
  if (url.protocol === 'http:') return false
  const scheme = url.protocol.slice(0, -1)
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && scheme.includes('.')
}

/** Returns true for HTTP loopback URLs accepted by native-app callback flows. */
export function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  )
}

/**
 * Returns true for HTTP URLs targeting private-use or link-local
 * networks (RFC 1918 ranges, `169.254/16`, mDNS `.local` hostnames).
 * Accepted alongside {@link isLoopbackHttp} for development flows where
 * a physical device reaches the dev machine over a LAN address.
 */
export function isPrivateHttp(url: URL): boolean {
  if (url.protocol !== 'http:') return false
  const { hostname } = url
  if (hostname.endsWith('.local')) return true
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)
  )
}

/** Returns true when an actual callback targets the registered callback URI. */
export function matchesCallback(url: URL, callback: string): boolean {
  const expected = new URL(callback)
  const actualBase =
    url.origin === 'null' ? `${url.protocol}${url.pathname}` : `${url.origin}${url.pathname}`
  const expectedBase =
    expected.origin === 'null'
      ? `${expected.protocol}${expected.pathname}`
      : `${expected.origin}${expected.pathname}`
  if (actualBase !== expectedBase) return false
  for (const [key, value] of expected.searchParams)
    if (!url.searchParams.getAll(key).includes(value)) return false
  return true
}

/** Reads a required query parameter that must appear exactly once. */
export function requiredSearchParam(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key)
  if (values.length !== 1 || !values[0]) return undefined
  return values[0]
}

/** Removes one trailing slash from a URI string. */
export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
