import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import type { IncomingHttpHeaders, Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocket as WsClient } from 'ws'
import type { McpToWebui, Conversation } from '../../src/types'
import { killWebuis, ping, snapshot, subscribe, webuiUp } from '../fixtures/browser'
import { baseEnv, DIST_CLI, freePort, startServer, webuiPids } from '../fixtures/e2e'
import type { Server } from '../fixtures/e2e'
import { parseReply, setup, sleep, spawnServer, until } from '../fixtures/harness'
import type { Harness, HarnessOptions } from '../fixtures/harness'

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url))
const DIST_WEBUI = join(DIST, 'webui.js')
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// ── HTTP, SSE and WebSocket clients ──

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
    }).on('error', reject)
  })
}

/** Connect to /mcp as an MCP server does: Node's WebSocket sends no Origin. */
async function connectMcp(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp`)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  return socket
}

const sendMcp = (socket: WebSocket, message: McpToWebui) => socket.send(JSON.stringify(message))

/** HTTP status of a /mcp upgrade that carries an Origin header, as a browser's would. */
function upgradeWithOrigin(port: number): Promise<number> {
  return new Promise(resolve => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/mcp`, { origin: 'http://evil.example' })
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('open', () => {
      resolve(101)
      ws.close()
    })
    ws.on('error', () => resolve(0))
  })
}

// ── Processes ──

interface WebuiProcess {
  pid: number
  exited: Promise<number | null>
  kill(): void
}

/** dist/webui.js with the default message count; `extra` replaces it, e.g. [] to leave it out. */
function spawnWebui(port: number, graceMs: number, file = DIST_WEBUI, extra = ['--max-message-count', '5000']): WebuiProcess {
  const child = spawn(process.execPath, [file, '--port', String(port), '--grace-ms', String(graceMs), ...extra], { stdio: 'ignore' })
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  return { pid: child.pid ?? 0, exited, kill: () => child.kill('SIGKILL') }
}

/** A server that answers every request with the given body, holding the port. */
async function holdPort(port: number, body: string): Promise<HttpServer> {
  const server = createServer((_req, res) => res.end(body))
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return server
}

const closeHttp = (server: HttpServer) => new Promise(resolve => server.close(resolve))

/** The grok adapter over the scripted agent, from a home MCP servers built from dist/ can load. */
async function withGrok(opts: HarnessOptions, fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setup({ ...opts, adapter: 'grok' })
  try {
    await fn(h)
  } finally {
    await h.cleanup()
  }
}

async function openSession(server: Server, h: Harness): Promise<string> {
  const opened = await server.call('open', { subagent: 'agent', cwd: h.dir })
  assert.equal(opened.isError, false, JSON.stringify(opened.data))
  return String(opened.data.session)
}

async function promptDone(server: Server, session: string, text = 'go'): Promise<void> {
  const reply = await server.call('prompt', { session, text })
  assert.equal(reply.data.status, 'done', JSON.stringify(reply.data))
}

const hasMethod = (session: Conversation | undefined, method: string) => session?.log.some(e => 'method' in e.message && e.message.method === method) ?? false

// ── Tests ──

describe('webui process', () => {
  test('U209 routes, file serving and the Host, Origin and path checks', { timeout: 30_000 }, async () => {
    const port = await freePort()
    const webui = spawnWebui(port, 60_000)
    try {
      await webuiUp(port)
      const pong = await ping(port)
      assert.deepEqual([pong?.name, pong?.protocol, pong?.pid], ['subagent-cockpit-webui', 1, webui.pid])

      const index = await request(port, '/')
      assert.equal(index.status, 200)
      assert.match(String(index.headers['content-type']), /text\/html/)
      // The page is minified: attribute values carry no quotes
      const asset = /src=(?<path>assets\/[^\s>]+\.js)/.exec(index.body)?.groups?.path
      assert.ok(asset, index.body)
      assert.equal((await request(port, `/${asset}`)).status, 200)
      assert.equal((await request(port, '/../package.json')).status, 404)
      assert.equal((await request(port, '/..%2f..%2fpackage.json')).status, 404)
      assert.equal((await request(port, '/', { Host: `evil.example:${port}` })).status, 403)
      assert.equal(await upgradeWithOrigin(port), 403)

      const live = await subscribe(port)
      await until(() => live.of('init').length === 1, 5000, 'init')
      const mcp = await connectMcp(port)
      sendMcp(mcp, { type: 'hello', pid: 4242, cwd: '/work', version: '9.9.9', started_at: 1 })
      sendMcp(mcp, { type: 'activity', session: 'grok_s1', at: 2, activity: { kind: 'session_opened', subagent: 'agent', adapter: 'grok', cwd: '/work', title: null, state: 'IDLE', reconnected: false } })
      sendMcp(mcp, { type: 'activity', session: 'grok_s1', at: 3, activity: { kind: 'acp', direction: 'out', message: { jsonrpc: '2.0', id: 0, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } } } })
      await until(() => live.of('activity').length === 2, 5000, 'activity')
      assert.deepEqual(live.frames.map(f => f.event), ['init', 'mcp_connected', 'activity', 'activity'])
      assert.equal(live.of('mcp_connected')[0].pid, 4242)
      live.close()

      const late = await subscribe(port)
      await until(() => late.of('init').length === 1, 5000, 'late init')
      await sleep(200)
      assert.deepEqual(late.frames.map(f => f.event), ['init'])
      const [init] = late.of('init')
      assert.deepEqual(init.mcps.map(m => [m.pid, m.connected]), [[4242, true]])
      assert.deepEqual(init.sessions.map(s => [s.session, s.subagent, s.log.length]), [['grok_s1', 'agent', 1]])
      assert.ok(init.sessions[0].items.some(item => item.kind === 'prompt'))
      late.close()
      mcp.close()
    } finally {
      webui.kill()
    }
  })

  test('U210 exits after the grace period without MCP servers, and at once when the port is taken', { timeout: 30_000 }, async () => {
    const [idle, left, back, taken] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
    const holder = await holdPort(taken, 'hello')
    const processes = [spawnWebui(idle, 500), spawnWebui(left, 500), spawnWebui(back, 500)]
    try {
      const [idleWebui, leftWebui, backWebui] = processes
      const started = Date.now()
      await Promise.all([webuiUp(left), webuiUp(back)])
      const leaving = await connectMcp(left)
      const returning = await connectMcp(back)
      leaving.close()
      returning.close()
      await sleep(300)
      const again = await connectMcp(back)

      assert.equal(await idleWebui.exited, 0)
      assert.ok(Date.now() - started >= 400)
      assert.equal(await leftWebui.exited, 0)
      await sleep(1000)
      assert.ok(await ping(back), 'reconnected within the grace period, still running')
      again.close()
      assert.equal(await backWebui.exited, 0)

      const busy = spawnWebui(taken, 500)
      const quick = Date.now()
      assert.equal(await busy.exited, 0)
      assert.ok(Date.now() - quick < 3000)
    } finally {
      processes.forEach(p => p.kill())
      await closeHttp(holder)
    }
  })

  test('U217 the build ships webui.js and the page, and they run without node_modules', { timeout: 60_000 }, async () => {
    await access(DIST_WEBUI)
    await access(join(DIST, 'html', 'index.html'))
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf-8' })
    const files: string[] = JSON.parse(pack.stdout)[0].files.map((f: { path: string }) => f.path)
    assert.ok(files.includes('dist/webui.js'))
    assert.ok(files.includes('dist/html/index.html'))

    const root = await mkdtemp(join(tmpdir(), 'cockpit-webui-'))
    const port = await freePort()
    await cp(DIST, join(root, 'dist'), { recursive: true })
    const webui = spawnWebui(port, 60_000, join(root, 'dist', 'webui.js'))
    try {
      await webuiUp(port)
      assert.match((await request(port, '/')).body, /<title>subagent-cockpit<\/title>/)
    } finally {
      webui.kill()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('MCP servers and the webui', () => {
  test('U211 two MCP servers share one webui, which outlives the first and exits after the last', { timeout: 90_000 }, () => withGrok({}, async h => {
    const port = await freePort()
    const first = await startServer(h.home, port)
    // The transport forgets the pid once closed
    const firstPid = first.pid
    try {
      await webuiUp(port)
      await until(async () => (await snapshot(port)).mcps.some(m => m.client?.name === 'e2e'), 10_000, 'first client')
      const live = await subscribe(port)
      const second = await startServer(h.home, port)
      try {
        await until(() => live.of('mcp_updated').some(m => m.pid === second.pid && m.client?.name === 'e2e'), 10_000, 'second client')
        assert.deepEqual(live.of('mcp_connected').map(m => m.pid), [second.pid])

        const sessions = await Promise.all([first, second].map(async server => {
          const session = await openSession(server, h)
          await promptDone(server, session)
          return session
        }))
        await until(async () => {
          const held = (await snapshot(port)).sessions
          return sessions.every(id => hasMethod(held.find(s => s.session === id), 'session/prompt'))
        }, 10_000, 'both sessions')
        assert.equal(webuiPids(port).length, 1)

        await first.close()
        await until(() => live.of('mcp_disconnected').length === 1, 10_000, 'first disconnected')
        const after = await snapshot(port)
        const firstMcp = after.mcps.find(m => m.pid === firstPid)
        assert.equal(firstMcp?.connected, false)
        assert.ok(after.sessions.some(s => s.mcp_id === firstMcp?.mcp_id && s.session === sessions[0]))
        live.close()
      } finally {
        await second.close()
      }
      // Default grace period: 10 seconds
      await until(() => webuiPids(port).length === 0, 20_000, 'webui exit')
    } finally {
      await first.close()
      killWebuis(port)
    }
  }))

  for (const [id, body, pattern] of [
    ['U212', 'hello', /in use by another program/],
    ['U213', '{"name":"subagent-cockpit-webui","protocol":999}', /speaks protocol 999/],
  ] as const) {
    test(`${id} a port answered by something else leaves the webui off and the tools working`, { timeout: 30_000 }, () => withGrok({}, async h => {
      const port = await freePort()
      const holder = await holdPort(port, body)
      const server = await startServer(h.home, port)
      try {
        const session = await openSession(server, h)
        await promptDone(server, session)
        await until(() => pattern.test(server.stderr()), 5000, String(pattern))
        assert.deepEqual(webuiPids(port), [])
      } finally {
        await server.close()
        await closeHttp(holder)
      }
    }))
  }

  test('U214 a webui killed is started again and learns the open sessions', { timeout: 60_000 }, () => withGrok({}, async h => {
    const port = await freePort()
    const server = await startServer(h.home, port)
    try {
      const sessions = [await openSession(server, h), await openSession(server, h)]
      await webuiUp(port)
      await until(async () => (await snapshot(port)).sessions.length === 2, 10_000, 'two sessions')
      const old = (await ping(port))?.pid ?? 0
      process.kill(old, 'SIGKILL')
      await until(async () => ![null, old].includes((await ping(port))?.pid ?? null), 15_000, 'new webui')
      await until(async () => (await snapshot(port)).sessions.length === 2, 10_000, 'sessions again')
      assert.deepEqual((await snapshot(port)).sessions.map(s => s.session).sort(), [...sessions].sort())
      await promptDone(server, sessions[0])
      await until(async () => hasMethod((await snapshot(port)).sessions.find(s => s.session === sessions[0]), 'session/prompt'), 10_000, 'new messages')
    } finally {
      await server.close()
      killWebuis(port)
    }
  }))

  test('U215 the environment variable wins over webui.port; 0 and invalid values turn the webui off', { timeout: 60_000 }, () => withGrok({}, async h => {
    const [configured, chosen] = await Promise.all([freePort(), freePort()])
    const configPath = join(h.home, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf-8'))
    await writeFile(configPath, JSON.stringify({ ...config, webui: { port: configured } }))

    const fromEnv = await startServer(h.home, chosen)
    try {
      await webuiUp(chosen)
      assert.equal(await ping(configured), null)
    } finally {
      await fromEnv.close()
      killWebuis(chosen)
    }

    for (const [value, pattern] of [['0', null], ['abc', /webui: invalid port abc; webui disabled/]] as const) {
      const server = await startServer(h.home, value)
      try {
        await openSession(server, h)
        await sleep(1500)
        assert.deepEqual(webuiPids(configured), [])
        if (pattern) assert.match(server.stderr(), pattern)
        else assert.doesNotMatch(server.stderr(), /webui/)
      } finally {
        await server.close()
      }
    }
  }))

  test('U216 two MCP servers starting at once end up with one webui', { timeout: 60_000 }, () => withGrok({}, async h => {
    const port = await freePort()
    const servers = await Promise.all([startServer(h.home, port), startServer(h.home, port)])
    try {
      await Promise.all(servers.map(server => openSession(server, h)))
      await webuiUp(port)
      await until(async () => {
        const { mcps, sessions } = await snapshot(port)
        return mcps.filter(m => m.connected).length === 2 && sessions.length === 2
      }, 15_000, 'both connected')
      assert.equal(webuiPids(port).length, 1)
    } finally {
      await Promise.all(servers.map(server => server.close()))
      killWebuis(port)
    }
  }))

  test('U219 an ACP message over 1 MB reaches the webui as a marker', { timeout: 60_000 }, () => withGrok({}, async h => {
    const port = await freePort()
    const server = await startServer(h.home, port)
    try {
      await webuiUp(port)
      await until(async () => (await snapshot(port)).mcps.length === 1, 10_000, 'connected')
      const session = await openSession(server, h)
      await promptDone(server, session, 'x'.repeat(1.1 * 1024 * 1024))
      await until(async () => (await snapshot(port)).sessions[0]?.items.some(item => item.kind === 'turn') ?? false, 10_000, 'turn end')
      const [held] = (await snapshot(port)).sessions
      const truncated = held.log.flatMap(({ message }) => ('truncated' in message ? [message] : []))
      assert.equal(truncated.length, 1)
      assert.equal(truncated[0].method, 'session/prompt')
      assert.ok(truncated[0].bytes > 1048576)
      assert.ok(held.log.some(({ message }) => 'result' in message && message.result !== null && typeof message.result === 'object' && 'stopReason' in message.result))
      // snapshot has its own default of the same 1 MB
      const items: Array<{ kind: string; data: Record<string, unknown> }> = (await server.call('snapshot', { session })).data.sessions[0].items
      const marker = items.find(item => item.kind === 'raw' && item.data.truncated === true)
      assert.deepEqual([marker?.data.method, Number(marker?.data.bytes) > 1048576], ['session/prompt', true])
    } finally {
      await server.close()
      killWebuis(port)
    }
  }))

  test('U248 the webui keeps webui.max_message_count messages, as passed by the server that starts it', { timeout: 60_000 }, () => withGrok({ scripts: { agent: { turns: [[{ chunks: 50 }]] } } }, async h => {
    const port = await freePort()
    const configPath = join(h.home, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf-8'))
    await writeFile(configPath, JSON.stringify({ ...config, webui: { ...config.webui, max_message_count: 30 } }))
    const server = await startServer(h.home, port)
    try {
      await webuiUp(port)
      const [pid] = webuiPids(port)
      assert.match(spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).stdout, /--max-message-count 30(\s|$)/)
      const session = await openSession(server, h)
      await promptDone(server, session)
      await until(async () => (await snapshot(port)).sessions[0]?.log.length === 30, 10_000, 'messages in')
      const [held] = (await snapshot(port)).sessions
      assert.equal(held.log.length, 30)
      assert.equal('changes' in held, false)
    } finally {
      await server.close()
      killWebuis(port)
    }
    // Without the count the webui does not start
    const missing = spawnWebui(await freePort(), 1000, DIST_WEBUI, [])
    assert.notEqual(await missing.exited, 0)
  }))

  test('U256 snapshot truncates by its own limit, apart from the webui', { timeout: 60_000 }, () => withGrok({ snapshot: { truncate_message_size: 2000 } }, async h => {
    const port = await freePort()
    const server = await startServer(h.home, port)
    try {
      await webuiUp(port)
      await until(async () => (await snapshot(port)).mcps.length === 1, 10_000, 'connected')
      const session = await openSession(server, h)
      const text = 'y'.repeat(5000)
      await promptDone(server, session, text)
      const items: Array<{ kind: string; data: Record<string, unknown> }> = (await server.call('snapshot', { session })).data.sessions[0].items
      const marker = items.find(item => item.kind === 'raw' && item.data.truncated === true)
      assert.ok(marker && Number(marker.data.bytes) > 2000, JSON.stringify(items.map(i => i.kind)))
      await until(async () => (await snapshot(port)).sessions[0]?.items.some(item => item.kind === 'turn') ?? false, 10_000, 'turn end')
      const prompt = (await snapshot(port)).sessions[0].items.find(item => item.kind === 'prompt' && JSON.stringify(item.data.prompt ?? null).includes(text))
      assert.ok(prompt, 'the webui has the full prompt')
    } finally {
      await server.close()
      killWebuis(port)
    }
  }))

  for (const adapter of ['antigravity', 'grok'] as const) {
    test(`U261 ${adapter}: a reconnect with the same id goes on with the conversation the webui shows`, { timeout: 90_000 }, async () => {
      const h = await setup({ adapter, scripts: { agent: adapter === 'grok' ? { replay: ['h1', 'h2'] } : {} } })
      const port = await freePort()
      const server = await startServer(h.home, port)
      try {
        await webuiUp(port)
        // Connected before the session opens, so the webui hears every message
        await until(async () => (await snapshot(port)).mcps.length === 1, 10_000, 'connected')
        const session = await openSession(server, h)
        await promptDone(server, session, 'one')
        const first = (await server.call('snapshot', {})).data
        await server.call('close', { session })
        const closed = (await server.call('snapshot', {})).data
        assert.deepEqual(closed.sessions, [])
        assert.equal((await server.call('open', { subagent: 'agent', cwd: h.dir, session })).isError, false)
        await promptDone(server, session, 'two')
        type Item = { id: string; kind: string; turn_id: number | null; rev: number; at: number; data: Record<string, unknown> }
        for (const since of [first, closed]) {
          const back = (await server.call('snapshot', { since: since.seq, server_id: since.server_id })).data
          assert.equal(back.reset, false)
          const items: Item[] = back.sessions[0].items
          assert.ok(items.every(item => item.rev > since.seq))
          assert.ok(items.some(item => item.kind === 'prompt' && JSON.stringify(item.data.prompt ?? null).includes('one')))
        }
        const full: Item[] = (await server.call('snapshot', { session })).data.sessions[0].items
        if (adapter === 'grok') {
          const replayed = full.findIndex(item => item.kind === 'message' && item.turn_id === null)
          const firstTurn = full.findIndex(item => item.kind === 'prompt' && JSON.stringify(item.data.prompt ?? null).includes('one'))
          assert.ok(replayed > firstTurn && firstTurn >= 0, JSON.stringify(full.map(i => [i.kind, i.turn_id])))
        }
        // Timestamps come from each process's clock; everything else matches the webui item for item
        const plain = (item: Record<string, unknown>) => {
          const { at: _at, rev: _rev, log: _log, data, ...rest } = item
          const { duration_ms: _duration, ...fields } = JSON.parse(JSON.stringify(data))
          return { ...rest, data: fields }
        }
        await until(async () => (await snapshot(port)).sessions.find(s => s.session === session)?.items.length === full.length, 10_000, 'webui caught up')
        const shown = (await snapshot(port)).sessions.find(s => s.session === session)?.items ?? []
        assert.deepEqual(shown.map(plain), full.map(plain))
      } finally {
        await server.close()
        killWebuis(port)
        await h.cleanup()
      }
    })
  }

  test('U220 test launches never reach the webui named by the inherited environment', { timeout: 60_000 }, () => withGrok({}, async h => {
    const port = await freePort()
    const requests: string[] = []
    const recorder = createServer((req, res) => {
      requests.push(String(req.url))
      res.end('recorded')
    })
    await new Promise<void>(resolve => recorder.listen(port, '127.0.0.1', resolve))
    const inherited = process.env.SUBAGENT_COCKPIT_WEBUI_PORT
    process.env.SUBAGENT_COCKPIT_WEBUI_PORT = String(port)
    try {
      const fromSource = await spawnServer(h.home)
      assert.equal((await fromSource.call('subagents')).isError, false)
      await fromSource.close()

      const fromDist = await startServer(h.home)
      assert.equal((await fromDist.call('subagents')).isError, false)
      await fromDist.close()

      // The form cli.test.ts and server.test.ts use: the inherited environment with the port set to 0
      const client = new Client({ name: 'test', version: '1' })
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI], env: { ...baseEnv(), SUBAGENT_COCKPIT_HOME: h.home, SUBAGENT_COCKPIT_WEBUI_PORT: '0' }, stderr: 'pipe' }))
      assert.equal(parseReply(await client.callTool({ name: 'subagents', arguments: {} })).isError, false)
      await client.close()

      await sleep(500)
      assert.deepEqual(requests, [])
      assert.deepEqual(webuiPids(port), [])
    } finally {
      if (inherited === undefined) delete process.env.SUBAGENT_COCKPIT_WEBUI_PORT
      else process.env.SUBAGENT_COCKPIT_WEBUI_PORT = inherited
      await closeHttp(recorder)
    }
  }))
})
