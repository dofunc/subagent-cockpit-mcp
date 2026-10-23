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
import type { SnapshotItem } from '../src/types'
import { CLI_SOURCE, HARNESS, isAlive, parseReply, recordActivity, setup, sleep, TSX, until } from './fixtures/harness'
import type { Harness, HarnessOptions } from './fixtures/harness'
import type { Step } from './fixtures/scripted-acp-agent'

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
  const server = createServer(h.manager, h.store, 'test', serverOpts)
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

  test('U253 snapshot params are checked against the declared schema', () => withHarness({}, async ({ client }) => {
    const bad: Array<Record<string, unknown>> = [{ types: ['foo'] }, { last: 0 }, { last: 1.5 }, { exclude_types: 'tool' }]
    await Promise.all(bad.map(args => assert.rejects(client.callTool({ name: 'snapshot', arguments: args }), { code: ErrorCode.InvalidParams }, JSON.stringify(args))))
    await structured(client, { name: 'snapshot', arguments: { last: 1 } })
    await structured(client, { name: 'snapshot', arguments: { types: ['tool', 'message'] } })
    const { tools } = await client.listTools()
    const schema = tools.find(t => t.name === 'snapshot')?.inputSchema.properties ?? {}
    assert.deepEqual(schema.last, { type: 'integer', minimum: 1, description: 'Only the last n items, after the kind filters' })
    assert.equal(JSON.parse(JSON.stringify(schema.types)).items.enum.length, 16)
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

interface Snap { server_id: string; seq: number; reset: boolean; sessions: Array<{ session: string; items: SnapshotItem[] }> }

/** snapshot through the MCP client, as plain data. */
async function snap(client: Client, args: Record<string, unknown> = {}): Promise<Snap> {
  return JSON.parse(JSON.stringify(await structured(client, { name: 'snapshot', arguments: args })))
}

const itemsOf = (s: Snap, session: string) => s.sessions.find(x => x.session === session)?.items ?? []
const textOf = (item: SnapshotItem | undefined) => (Array.isArray(item?.data.content) ? item.data.content : []).map(b => JSON.parse(JSON.stringify(b)).text ?? '').join('')
const openVia = async (client: Client, h: Harness) => String((await structured(client, { name: 'open', arguments: { subagent: 'agent', cwd: h.dir } })).session)
const promptVia = (client: Client, session: string, text: string) => structured(client, { name: 'prompt', arguments: { session, text } })

describe('snapshot', () => {
  const THOUGHT = { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } } } satisfies Step
  const DIFF = { type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }
  const TOOL: Step[] = [
    { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'pending' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [DIFF] } },
  ]
  const PLAN = { update: { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'in_progress' }] } } satisfies Step

  test('U249 items are the conversation the webui shows, each with its revision', () => withHarness({
    scripts: { agent: { turns: [[THOUGHT, { chunk: 'Hel' }, { chunk: 'lo' }, ...TOOL, PLAN]] } },
  }, async ({ h, client }) => {
    const session = await openVia(client, h)
    const r = await promptVia(client, session, 'go')
    const turn = itemsOf(await snap(client), session).filter(i => i.turn_id === r.turn_id)
    assert.deepEqual(turn.map(i => i.kind), ['prompt', 'thought', 'message', 'tool', 'plan', 'turn'])
    assert.deepEqual(turn[0].data.prompt, [{ type: 'text', text: 'go' }])
    assert.deepEqual(turn[2].data.content, [{ type: 'text', text: 'Hello' }])
    assert.deepEqual([turn[3].data.status, turn[3].data.content], ['completed', [{ type: 'diff', ...DIFF }]])
    assert.ok(turn.every(i => typeof i.rev === 'number' && !('log' in i)))
    // The same merge as the webui: the store's view and the snapshot agree
    assert.deepEqual(h.store.items(session, undefined).filter(i => i.turn_id === r.turn_id), turn)
  }))

  test('U250 session picks one session; an unknown one is SESSION_NOT_FOUND', () => withHarness({}, async ({ h, client }) => {
    const [a] = [await openVia(client, h), await openVia(client, h)]
    assert.deepEqual((await snap(client, { session: a })).sessions.map(s => s.session), [a])
    const missing = parseReply(await client.callTool({ name: 'snapshot', arguments: { session: 'codex_nope' } }))
    assert.deepEqual([missing.isError, missing.data.code], [true, 'SESSION_NOT_FOUND'])
  }))

  test('U251 types keeps kinds, exclude_types drops them, types first', () => withHarness({
    scripts: { agent: { turns: [[THOUGHT, { chunk: 'x' }, ...TOOL]] } },
  }, async ({ h, client }) => {
    const session = await openVia(client, h)
    await promptVia(client, session, 'go')
    const kinds = async (args: Record<string, unknown>) => [...new Set(itemsOf(await snap(client, { session, ...args }), session).map(i => i.kind))]
    assert.deepEqual(await kinds({ types: ['tool'] }), ['tool'])
    assert.ok(!(await kinds({ exclude_types: ['thought'] })).includes('thought'))
    assert.deepEqual(await kinds({ types: ['message', 'thought'], exclude_types: ['thought'] }), ['message'])
  }))

  test('U252 last takes the last n items, after the kind filters', () => withHarness({
    scripts: { agent: { turns: [Array.from({ length: 7 }, (_, i): Step => ({ chunk: `m${i}`, messageId: `id${i}` }))] } },
  }, async ({ h, client }) => {
    const session = await openVia(client, h)
    await promptVia(client, session, 'go')
    const all = itemsOf(await snap(client, { session }), session)
    assert.equal(all.length, 12)
    assert.deepEqual(itemsOf(await snap(client, { session, last: 3 }), session), all.slice(-3))
    const [last] = itemsOf(await snap(client, { session, types: ['message'], last: 1 }), session)
    assert.equal(textOf(last), 'm6')
  }))

  test('U32 since returns only the items changed after it', () => withHarness({ scripts: { agent: { turns: [[{ chunk: 'a' }], [{ chunk: 'b' }]] } } }, async ({ h, client }) => {
    const session = await openVia(client, h)
    await promptVia(client, session, 'one')
    const first = await snap(client)
    await promptVia(client, session, 'two')
    const next = await snap(client, { since: first.seq, server_id: first.server_id })
    assert.equal(next.reset, false)
    assert.deepEqual(itemsOf(next, session).filter(i => i.kind === 'message').map(textOf), ['b'])
    assert.ok(itemsOf(next, session).every(i => i.rev > first.seq))
  }))

  test('U254 filters never move the cursor', () => withHarness({ scripts: { agent: { turns: [[THOUGHT, ...TOOL], [{ chunk: 'later' }]] } } }, async ({ h, client }) => {
    const session = await openVia(client, h)
    await promptVia(client, session, 'go')
    const tools = await snap(client, { types: ['tool'] })
    await promptVia(client, session, 'again')
    const next = await snap(client, { since: tools.seq, server_id: tools.server_id })
    assert.equal(next.reset, false)
    assert.ok(!itemsOf(next, session).some(i => i.kind === 'thought'))
    assert.deepEqual(itemsOf(next, session).filter(i => i.kind === 'message').map(textOf), ['later'])
  }))

  test('U255 a tool that changes after since comes again with its new state', () => withHarness({
    scripts: { agent: { turns: [[TOOL[0], { sleep: 800 }, TOOL[1]]] } },
  }, async ({ h, client }) => {
    const session = await openVia(client, h)
    await structured(client, { name: 'prompt', arguments: { session, text: 'go', wait: false } })
    await until(() => h.store.items(session, undefined).some(i => i.kind === 'tool'), 5000, 'tool started')
    const before = await snap(client)
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'turn done')
    const tool = itemsOf(await snap(client, { since: before.seq, server_id: before.server_id }), session).find(i => i.kind === 'tool')
    assert.ok(tool && tool.rev > before.seq)
    assert.equal(tool?.data.status, 'completed')
  }))

  test('U257 a closed session is no longer returned', () => withHarness({}, async ({ h, client }) => {
    const [a, b] = [await openVia(client, h), await openVia(client, h)]
    await structured(client, { name: 'close', arguments: { session: a } })
    assert.deepEqual((await snap(client)).sessions.map(s => s.session), [b])
  }))

  test('U66 items lost to the retention limit after since reset', () => withHarness({ snapshot: { max_message_count: 40 }, scripts: { agent: { turns: [[{ chunks: 60 }]] } } }, async ({ h, client }) => {
    const session = await openVia(client, h)
    const before = await snap(client)
    await promptVia(client, session, 'go')
    const next = await snap(client, { since: before.seq, server_id: before.server_id })
    assert.equal(next.reset, true)
    assert.deepEqual(itemsOf(next, session), h.store.items(session, undefined))
  }))

  test('U67 another server_id resets', () => withHarness({}, async ({ h, client }) => {
    await openVia(client, h)
    const first = await snap(client)
    assert.equal((await snap(client, { since: first.seq, server_id: 'other' })).reset, true)
  }))

  test('U260 one session losing items resets every selected session', () => withHarness({
    snapshot: { max_message_count: 40 },
    scripts: { a: { turns: [[{ chunks: 60 }]] }, b: {} },
  }, async ({ h, client }) => {
    const a = String((await structured(client, { name: 'open', arguments: { subagent: 'a', cwd: h.dir } })).session)
    const b = String((await structured(client, { name: 'open', arguments: { subagent: 'b', cwd: h.dir } })).session)
    const before = await snap(client)
    await promptVia(client, a, 'go')
    const next = await snap(client, { since: before.seq, server_id: before.server_id })
    assert.equal(next.reset, true)
    assert.deepEqual(itemsOf(next, a), h.store.items(a, undefined))
    assert.deepEqual(itemsOf(next, b), itemsOf(before, b))
  }))

  test('U272 a session closed while another one reset comes back whole on reconnect', () => withHarness({
    snapshot: { max_message_count: 40 },
    scripts: { a: {}, b: { turns: [[{ chunks: 60 }]] } },
  }, async ({ h, client }) => {
    const a = String((await structured(client, { name: 'open', arguments: { subagent: 'a', cwd: h.dir } })).session)
    const b = String((await structured(client, { name: 'open', arguments: { subagent: 'b', cwd: h.dir } })).session)
    await promptVia(client, a, 'go')
    await structured(client, { name: 'close', arguments: { session: a } })
    const closed = await snap(client)
    await promptVia(client, b, 'go')
    const reset = await snap(client, { since: closed.seq, server_id: closed.server_id })
    assert.equal(reset.reset, true)
    assert.ok(!reset.sessions.some(s => s.session === a))
    await structured(client, { name: 'open', arguments: { subagent: 'a', cwd: h.dir, session: a } })
    const back = await snap(client, { since: reset.seq, server_id: reset.server_id })
    assert.equal(back.reset, false)
    assert.deepEqual(itemsOf(back, a), itemsOf(await snap(client, { session: a }), a))
    assert.ok(itemsOf(back, a).some(i => i.kind === 'prompt' && JSON.stringify(i.data.prompt).includes('go')))
  }))

  test('U274 close then delete lets the conversation go', () => withHarness({ scripts: { agent: { delete: true } } }, async ({ h, client }) => {
    const seen = recordActivity(h.manager)
    const session = await openVia(client, h)
    await promptVia(client, session, 'go')
    await structured(client, { name: 'close', arguments: { session } })
    assert.ok(h.store.items(session, undefined).length > 0)
    await structured(client, { name: 'delete', arguments: { session } })
    assert.ok(seen.some(a => a.session === session && a.activity.kind === 'session_closed' && a.activity.reason === 'deleted'))
    assert.deepEqual(h.store.items(session, undefined), [])
    assert.equal(h.store.lostSince(session, 0), false)
  }))
})

describe('reopening an idle-closed session over MCP', () => {
  /** Open a session and wait until it was closed for idleness and its lock is gone. */
  async function idleSession(h: Harness, client: Client): Promise<string> {
    const seen = recordActivity(h.manager)
    const session = await openVia(client, h)
    await until(() => seen.some(a => a.session === session && a.activity.kind === 'session_closed' && a.activity.reason === 'idle'), 8000, 'idle close')
    await until(async () => (await readFile(join(h.home, 'sessions', session, 'lock.pid')).then(() => false, () => true)), 5000, 'lock released')
    return session
  }

  for (const cancelled of ['A', 'B'] as const) {
    test(`U284 cancelling ${cancelled} while the reopen loads leaves the other call alone`, () => withHarness({ idle: { timeout: 2 } }, async ({ h, client }) => {
      const session = await idleSession(h, client)
      await h.setScript('agent', { delays: { loadSession: 1500 } })
      const before = (await h.events('start')).length
      const controllers = { A: new AbortController(), B: new AbortController() }
      const call = (name: 'A' | 'B') => client.callTool({ name: 'prompt', arguments: { session, text: name } }, undefined, { signal: controllers[name].signal })
      const a = call('A')
      await sleep(100)
      const b = call('B')
      await until(async () => (await h.events('load')).length === 1, 5000, 'load started')
      controllers[cancelled].abort()
      const kept = cancelled === 'A' ? b : a
      await assert.rejects(cancelled === 'A' ? a : b)
      assert.equal(parseReply(await kept).data.status, 'done')
      const prompts = (await h.events('prompt')).map(e => e.text).filter(t => t === 'A' || t === 'B')
      assert.deepEqual(prompts, [cancelled === 'A' ? 'B' : 'A'])
      assert.equal((await h.events('start')).length, before + 1)
      assert.equal((await h.events('load')).length, 1)
    }))
  }

  test('U284 a request cancelled on arrival starts nothing; a failed reopen leaves no unobserved rejection', () => withHarness({ idle: { timeout: 2 } }, async ({ h, client }) => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', record)
    try {
      const session = await idleSession(h, client)
      await h.setScript('agent', { delays: { loadSession: 800 }, errors: { load: true } })
      const a = h.manager.prompt(session, 'A', true)
      const aborted = new AbortController()
      aborted.abort()
      await assert.rejects(h.manager.prompt(session, 'B', true, aborted.signal), { message: 'Request cancelled' })
      await assert.rejects(a, { code: 'AGENT_ERROR' })
      await sleep(200)
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', record)
    }
  }))
})
