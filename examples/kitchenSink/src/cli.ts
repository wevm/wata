import { consumer } from './consumer.js'

const argv = (globalThis as { process?: { argv?: string[] | undefined } }).process?.argv ?? []

if (argv.includes('--help') || argv.includes('-h'))
  console.log(`Kitchen Sink CLI

Usage:
  pnpm dev:cli

Requires \`pnpm dev\` in another terminal on http://localhost:5173.
`)
else {
  const { result } = await consumer.deviceCode.send({
    method: 'ping',
    params: [{ message: 'hello from CLI consumer' }],
  })

  console.log('result:', result)
}
