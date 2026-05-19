export function getRequestListener() {
  return () => {
    throw new Error('@hono/node-server is not available in React Native')
  }
}
