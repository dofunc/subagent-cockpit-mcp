// Shared pieces of the webui tests: reading the webui as a browser does (SSE), and the mock behind the
// mock layer. No Playwright import here, so the node:test suites use it too.
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { ConversationStreamEvents, WebuiPingResult } from '../../src/types'
import { freePort, webuiPids } from './e2e'
import { until } from './harness'

const MOCK = fileURLToPath(new URL('../../mock/webui.ts', import.meta.url))
const TSX = import.meta.resolve('tsx')

/** /api/ping, or null when nothing answers it with JSON. */
export const ping = (port: number): Promise<WebuiPingResult | null> =>
  fetch(`http://127.0.0.1:${port}/api/ping`).then(async res => JSON.parse(await res.text())).catch(() => null)

export interface Stream {
  /** Frames received so far, in order */
  frames: Array<{ event: string; data: string }>
  of<K extends keyof ConversationStreamEvents>(event: K): ConversationStreamEvents[K][]
  close(): void
}

/** Subscribe to /api/stream as a browser would. */
export function subscribe(port: number): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const frames: Stream['frames'] = []
    const pending = { text: '' }
    const req = get({ host: '127.0.0.1', port, path: '/api/stream' }, res => {
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => {
        const parts = `${pending.text}${chunk}`.split('\n\n')
        pending.text = parts.pop() ?? ''
        parts.forEach(part => {
          const match = /^event: (?<event>.+)\ndata: (?<data>.*)$/s.exec(part)
          match?.groups && frames.push({ event: match.groups.event, data: match.groups.data })
        })
      })
      resolve({
        frames,
        of: event => frames.filter(f => f.event === event).map(f => JSON.parse(f.data)),
        close: () => req.destroy(),
      })
    })
    // Destroying the request on close ends it with an error; only a failure before the response matters
    req.on('error', reject)
  })
}

/** Everything the webui holds right now: the `init` of a fresh subscription. */
export async function snapshot(port: number): Promise<ConversationStreamEvents['init']> {
  const stream = await subscribe(port)
  try {
    await until(() => stream.of('init').length > 0, 5000, 'init')
    return stream.of('init')[0]
  } finally {
    stream.close()
  }
}

/** A webui outlives its last MCP server by the grace period; end the one on this port now. */
export const killWebuis = (port: number) => webuiPids(port).forEach(pid => process.kill(pid, 'SIGKILL'))

/** Wait until a webui answers on the port. */
export const webuiUp = (port: number) => until(async () => (await ping(port)) !== null, 10_000, `webui on ${port}`)

export interface Mock {
  url: string
  port: number
  stop(): void
}

/**
 * Start mock/webui.ts on a free port with the live part sent at once (COCKPIT_MOCK_REPLAY_MS=0), and
 * resolve once it prints its address: by then every activity has gone out to the webui.
 */
export async function startMock(): Promise<Mock> {
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', TSX, MOCK], {
    env: { ...process.env, COCKPIT_MOCK_WEBUI_PORT: String(port), COCKPIT_MOCK_REPLAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const output = { text: '' }
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output.text += chunk.toString()
      output.text.includes(`http://127.0.0.1:${port}`) && resolve()
    })
    child.once('exit', code => reject(new Error(`webui mock exited with ${code}: ${output.text}`)))
  })
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop() {
      child.kill('SIGKILL')
      // A killed mock never kills its webui
      killWebuis(port)
    },
  }
}
