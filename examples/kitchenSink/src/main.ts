import { consumer } from './consumer.js'

const log = document.getElementById('log') as HTMLPreElement
const serverButton = document.getElementById('server') as HTMLButtonElement
const webButton = document.getElementById('web') as HTMLButtonElement

const append = (line: string) => {
  log.textContent += `${line}\n`
}

const session = await consumer.postMessage.start()

webButton.addEventListener('click', async () => {
  try {
    const { result } = await session.send({
      method: 'ping',
      params: [{ message: 'hello from web consumer' }],
    })
    append(`web result: ${JSON.stringify(result)}`)
  } catch (error) {
    append(`web error: ${(error as Error).message}`)
  }
})

serverButton.addEventListener('click', async () => {
  try {
    const response = await fetch('/demo/server', { method: 'POST' })
    const body = (await response.json()) as Record<string, unknown>
    if (typeof body.verificationUri === 'string') {
      append(`server approval: ${body.verificationUri}`)
      window.open(body.verificationUri, 'wata-webhook-approval', 'popup=1,width=420,height=360')
    } else {
      append(`server status: ${JSON.stringify(body)}`)
    }
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const resultResponse = await fetch('/demo/server/result')
      const resultBody = (await resultResponse.json()) as Record<string, unknown>
      if (resultBody.status === 'pending') continue
      append(`server result: ${JSON.stringify(resultBody)}`)
      break
    }
  } catch (error) {
    append(`server error: ${(error as Error).message}`)
  }
})
