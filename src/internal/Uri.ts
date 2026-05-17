/** Ensures a path string starts with `/`. */
export function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`
}

/** Removes one trailing slash from a URI string. */
export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
