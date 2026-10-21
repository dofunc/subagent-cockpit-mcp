import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolRequest, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { createServer } from '../src/server'
import type { ServerOptions } from '../src/server'
import { CLI_SOURCE, HARNESS, isAlive, parseReply, setup, sleep, TSX, until } from './fixtures/harness'
import type { Harness, HarnessOptions } from './fixtures/harness'

const DIST_CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

const TOOL_NAMES = ['subagents', 'sessions', 'open', 'prompt', 'approve', 'allow', 'reject', 'answer', 'cancel', 'set_config', 'status', 'progress', 'output', 'close', 'delete', 'snapshot']

interface Context {
  h: Harness
  client: Client
  /** Every message the client received, in order. */
  received: JSONRPCMessage[]
}

async function withHarness(opts: HarnessOptions, fn: (ctx: Context) => Promise<void>, serverOpts: ServerOptions = {}): Promise<void> {
  const h = await setup(opts)
  const server = createServer(h.manager, 'test', serverOpts)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  const received: JSONRPCMessage[] = []
  const dispatch = clientSide.onmessage
  clientSide.onmessage = (message, extra) => {
    received.push(message)
    dispatch?.(message, extra)
  }
  try {
    await fn({ h, client, received })
  } finally {
    await client.close()
    await h.cleanup()
  }
}

const progressCount = (received: JSONRPCMessage[]) => received.filter(m => 'method' in m && m.method === 'notifications/progress').length

/** Call a tool and check the structured result against the text block. */
async function structured(client: Client, params: CallToolRequest['params']): Promise<Record<string, unknown>> {
  const result = await client.callTool(params)
  assert.notEqual(result.isError, true, JSON.stringify(result.content))
  assert.ok(result.structuredContent, `${params.name} has structuredContent`)
  const { data } = parseReply(result)
  assert.deepEqual(data, result.structuredContent)
  return data
}

describe('MCP server', () => {
  test('U47 the built server lists all 16 tools, each with an outputSchema', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-mcp-'))
    const client = new Client({ name: 'test', version: '1' })
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI], env: { PATH: process.env.PATH ?? '', SUBAGENT_COCKPIT_HOME: home, SUBAGENT_COCKPIT_WEBUI_PORT: '0' }, stderr: 'pipe' }))
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map(t => t.name), TOOL_NAMES)
      assert.ok(tools.every(t => t.outputSchema?.type === 'object'))
      assert.ok(tools.every(t => t.inputSchema.additionalProperties === false))
    } finally {
      await client.close()
      await rm(home, { recursive: true, force: true })
    }
  })

  test('U48 errors carry isError and the error code, without structuredContent', () => withHarness({}, async ({ client }) => {
    const result = await client.callTool({ name: 'status', arguments: { session: 'codex_nope' } })
    const reply = parseReply(result)
    assert.equal(reply.isError, true)
    assert.equal(reply.data.code, 'SESSION_NOT_FOUND')
    assert.equal(result.structuredContent, undefined)
  }))

  test('U69 open no longer takes a task', () => withHarness({}, async ({ h, client }) => {
    await assert.rejects(client.callTool({ name: 'open', arguments: { subagent: 'agent', cwd: h.dir, prompt: 'task' } }), { code: ErrorCode.InvalidParams, message: /unknown parameter: prompt/ })
    assert.equal((await h.events('start')).length, 0)
  }))

  test('U110 bad arguments and unknown tools are JSON-RPC invalid params', () => withHarness({}, async ({ client }) => {
    const calls: CallToolRequest['params'][] = [
      { name: 'nope', arguments: {} },
      { name: 'status', arguments: {} },
      { name: 'status', arguments: { session: 1 } },
      { name: 'status', arguments: { session: 'codex_x', extra: true } },
    ]
    await Promise.all(calls.map(c => assert.rejects(client.callTool(c), { code: ErrorCode.InvalidParams })))
  }))

  test('U109 structured results match each outputSchema', () => withHarness({
    scripts: {
      agent: {
        delete: true,
        turns: [[
          { permission: {} },
          { update: { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'in_progress' }] } },
          { update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.1, currency: 'USD' } } },
          { update: { sessionUpdate: 'session_info_update', title: 'T' } },
          { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review' }] } },
          { question: { message: 'Q' } },
          { chunk: 'after' },
        ], [{ sleep: 2000 }]],
      },
    },
  }, async ({ h, client }) => {
    // listTools caches the output validators the SDK client applies to every call
    await client.listTools()
    await structured(client, { name: 'subagents', arguments: {} })
    const opened = await structured(client, { name: 'open', arguments: { subagent: 'agent', cwd: h.dir } })
    const session = String(opened.session)
    const asked = await structured(client, { name: 'prompt', arguments: { session, text: 'go' } })
    assert.equal(asked.status, 'approval_needed')
    await structured(client, { name: 'snapshot', arguments: {} })
    const approvalId = String(h.manager.status(session).approvals[0].approval_id)
    const questioned = await structured(client, { name: 'approve', arguments: { session, approval_id: approvalId } })
    assert.equal(questioned.status, 'question_needed')
    await structured(client, { name: 'snapshot', arguments: {} })
    await structured(client, { name: 'status', arguments: { session } })
    const questionId = String(h.manager.status(session).questions[0].question_id)
    assert.equal((await structured(client, { name: 'answer', arguments: { session, question_id: questionId, content: { q0: 'red' } } })).status, 'done')
    assert.equal((await structured(client, { name: 'progress', arguments: { session } })).title, 'T')
    await until(async () => (await h.manager.list())[0].title === 'T', 5000, 'title saved')
    await structured(client, { name: 'sessions', arguments: { cwd: h.dir } })
    await structured(client, { name: 'output', arguments: { session } })
    await structured(client, { name: 'set_config', arguments: { session, config_id: 'model', value: 'x' } })
    await structured(client, { name: 'prompt', arguments: { session, text: 'long', wait: false } })
    await structured(client, { name: 'status', arguments: { session } })
    await structured(client, { name: 'cancel', arguments: { session } })
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'cancelled')
    await structured(client, { name: 'delete', arguments: { session } })
    await structured(client, { name: 'close', arguments: {} })
  }))

  test('U175 bad answer and progress arguments are JSON-RPC invalid params', () => withHarness({ scripts: { agent: { turns: [[{ question: { message: 'Q' } }]] } } }, async ({ h, client }) => {
    const opened = await structured(client, { name: 'open', arguments: { subagent: 'agent', cwd: h.dir } })
    const session = String(opened.session)
    assert.equal((await structured(client, { name: 'prompt', arguments: { session, text: 'go' } })).status, 'question_needed')
    const [{ question_id }] = h.manager.status(session).questions
    const calls: CallToolRequest['params'][] = [
      { name: 'answer', arguments: { session, question_id, action: 'maybe' } },
      { name: 'answer', arguments: { session, question_id, content: ['red'] } },
      { name: 'answer', arguments: { session, question_id, content: { x: { nested: true } } } },
      { name: 'answer', arguments: { session, question_id, content: { y: ['a', 1] } } },
      { name: 'progress', arguments: {} },
    ]
    await calls.reduce(async (prev, c) => {
      await prev
      await assert.rejects(client.callTool(c), { code: ErrorCode.InvalidParams }, JSON.stringify(c))
    }, Promise.resolve())
    assert.equal(h.manager.status(session).questions.length, 1)
    assert.equal((await h.events('question')).length, 0)
  }))

  test('U20 after a cancelled request, status and output return the result', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 1000 }, { chunk: 'late' }]] } } }, async ({ h, client }) => {
    const session = String((await structured(client, { name: 'open', arguments: { subagent: 'agent', cwd: h.dir } })).session)
    const abort = new AbortController()
    const call = client.callTool({ name: 'prompt', arguments: { session, text: 'go' } }, undefined, { signal: abort.signal })
    await sleep(200)
    abort.abort()
    await assert.rejects(call)
    assert.equal((await structured(client, { name: 'status', arguments: { session } })).state, 'RUNNING')
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'turn done')
    assert.equal((await structured(client, { name: 'output', arguments: { session } })).output, 'late')
    assert.equal((await h.events('cancel')).length, 0)
  }))

  test('U22 blocking calls send progress heartbeats only when asked', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 1000 }, { chunk: 'a' }], [{ sleep: 1000 }, { chunk: 'b' }]] } } }, async ({ h, client, received }) => {
    const session = String((await structured(client, { name: 'open', arguments: { subagent: 'agent', cwd: h.dir } })).session)
    const progress: number[] = []
    await client.callTool({ name: 'prompt', arguments: { session, text: 'one' } }, undefined, { onprogress: p => progress.push(p.progress) })
    assert.ok(progress.length >= 3, `progress ${progress}`)
    assert.ok(progress.every((p, i) => i === 0 || p > progress[i - 1]), `progress ${progress}`)
    const afterFirst = progressCount(received)
    await sleep(300)
    assert.equal(progressCount(received), afterFirst)
    await client.callTool({ name: 'prompt', arguments: { session, text: 'two' } })
    assert.equal(progressCount(received), afterFirst)
  }, { heartbeatMs: 100 }))

  test('U96 a cancelled MCP request withdraws the waiter but not the turn', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 1500 }, { chunk: 'x' }]] } } }, async ({ h, client }) => {
    const opened = parseReply(await client.callTool({ name: 'open', arguments: { subagent: 'agent', cwd: h.dir } }))
    const session = String(opened.data.session)
    const abort = new AbortController()
    const call = client.callTool({ name: 'prompt', arguments: { session, text: 'go' } }, undefined, { signal: abort.signal })
    await sleep(300)
    assert.equal(h.manager.snapshot({}).sessions[0].waiting, true)
    abort.abort()
    await assert.rejects(call)
    await until(() => !h.manager.snapshot({}).sessions[0].waiting, 2000, 'waiter withdrawn')
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'turn done')
    assert.equal((await h.events('cancel')).length, 0)
    const notices = h.manager.snapshot({}).sessions[0].notifications
    assert.ok(notices.some(n => n.type === 'turn' && n.outcome === 'done'))
  }))

  test('U49 closing stdin closes all sessions and exits 0', { timeout: 30_000 }, async () => {
    const h = await setup({})
    try {
      const child = spawn(process.execPath, ['--import', TSX, '--import', HARNESS, CLI_SOURCE], {
        env: { ...process.env, SUBAGENT_COCKPIT_HOME: h.home, SUBAGENT_COCKPIT_WEBUI_PORT: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
      const replies: Array<{ id?: number; result?: { content: Array<{ text: string }> } }> = []
      const buffer = { text: '' }
      child.stdout.on('data', (chunk: Buffer) => {
        const lines = `${buffer.text}${chunk.toString()}`.split('\n')
        buffer.text = lines.pop() ?? ''
        lines.filter(Boolean).forEach(l => replies.push(JSON.parse(l)))
      })
      const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`)
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open', arguments: { subagent: 'agent', cwd: h.dir } } })
      await until(() => replies.some(r => r.id === 2), 15_000, 'open reply')
      const session = JSON.parse(replies.find(r => r.id === 2)?.result?.content[0].text ?? '{}').session
      const [agent] = await h.events('start')
      child.stdin.end()
      assert.equal(await exited, 0)
      await until(() => !isAlive(Number(agent.pid)), 5000, 'agent exit')
      await assert.rejects(readFile(join(h.home, 'sessions', session, 'lock.pid')), { code: 'ENOENT' })
    } finally {
      await h.cleanup()
    }
  })
})
