/*
 * Mock MCP servers for the webui — the data behind `npm run webui:mock`.
 *
 * Starts dist/webui.js on its own port (COCKPIT_MOCK_WEBUI_PORT, default 7201, never the real 7200)
 * and connects two fake MCP servers to it over WebSocket /mcp, the way src/webui/link.ts does. The
 * page knows nothing about the mock: it reads /api/stream as always, so the webui process, the SSE
 * stream, the browser store and the shared reducer all run for real.
 *
 * The history goes out at once, then mcp-b disconnects and the live part plays one activity every
 * COCKPIT_MOCK_REPLAY_MS (default 150 ms; 0 sends it at once, before the address is printed, for the
 * mock browser tests). Messages follow the ACP shapes of @agentclientprotocol/sdk types.gen.d.ts.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AcpWireMessage, AgentState, JsonObject, JsonValue, McpToWebui, ConversationActivity, TruncatedMessage, WebuiPingResult } from '../src/types'
import { WEBUI_NAME } from '../src/webui/protocol'

/** One activity and the fake MCP server that sends it. */
interface Event {
  mcp: string
  session: string
  at: number
  activity: ConversationActivity
}

/** A fake MCP server: what it says in hello and client. */
interface FakeMcp {
  id: string
  pid: number
  cwd: string
  client: { name: string; version: string }
}

type Direction = 'in' | 'out'

/** What an agent answers to initialize and session/new. */
interface AgentFixture {
  info: JsonObject
  capabilities: JsonObject
  auth: JsonValue[]
  session: JsonObject
}

const REPLAY_INTERVAL_MS = Number(process.env.COCKPIT_MOCK_REPLAY_MS ?? 150)
const clock = { now: Date.now() - 40 * 60_000, turn: 0 }
const tick = () => (clock.now += 700)

const WEBUI = fileURLToPath(new URL('../dist/webui.js', import.meta.url))
const PORT = Number(process.env.COCKPIT_MOCK_WEBUI_PORT ?? 7201)
const STARTED_AT = clock.now

// mcp-b leaves once the history is out, so the page shows a disconnected server
const MCPS: FakeMcp[] = [
  { id: 'mcp-a', pid: 41203, cwd: '/Users/dev/repo', client: { name: 'claude-code', version: '2.1.40' } },
  { id: 'mcp-b', pid: 51877, cwd: '/Users/dev/web', client: { name: 'codex-mcp-client', version: '0.60.1' } },
]

const text = (value: string) => ({ type: 'text', text: value })
const chunks = (value: string, size: number) => value.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []
const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, thoughtTokens: Math.round(output / 3), cachedReadTokens: input * 2, totalTokens: input + output })

/** One session's activity, in the order the webui would receive it. */
class Script {
  readonly events: Event[] = []
  readonly live: Event[] = []
  private replaying = false
  private ids: Record<Direction, number> = { in: 0, out: 0 }

  constructor(private readonly mcp: string, readonly adapter: string, readonly nativeId: string) {}

  get session(): string {
    return `${this.adapter}_${this.nativeId}`
  }

  /** Everything after this call is played back one by one on a timer. */
  goLive(): this {
    this.replaying = true
    return this
  }

  act(activity: ConversationActivity): this {
    (this.replaying ? this.live : this.events).push({ mcp: this.mcp, session: this.session, at: tick(), activity })
    return this
  }

  send(direction: Direction, message: AcpWireMessage | TruncatedMessage): this {
    return this.act({ kind: 'acp', direction, message })
  }

  request(direction: Direction, method: string, params: JsonObject): number {
    const id = this.ids[direction]++
    this.send(direction, { jsonrpc: '2.0', id, method, params })
    return id
  }

  notify(direction: Direction, method: string, params: JsonObject): this {
    return this.send(direction, { jsonrpc: '2.0', method, params })
  }

  /** `direction` is the side sending the response. */
  respond(direction: Direction, id: number, result: JsonValue): this {
    return this.send(direction, { jsonrpc: '2.0', id, result })
  }

  fail(direction: Direction, id: number, error: { code: number; message: string; data?: JsonValue }): this {
    return this.send(direction, { jsonrpc: '2.0', id, error })
  }

  update(update: JsonObject): this {
    return this.notify('in', 'session/update', { sessionId: this.nativeId, update })
  }

  state(state: AgentState, cancelling = false): this {
    return this.act({ kind: 'state', state, cancelling })
  }

  say(message: string, messageId: string | null = null, size = 400, sessionUpdate = 'agent_message_chunk'): this {
    chunks(message, size).forEach(part => this.update({ sessionUpdate, content: text(part), ...(messageId === null ? {} : { messageId }) }))
    return this
  }

  open(subagent: string, cwd: string, title: string | null = null, reconnected = false): this {
    return this.act({ kind: 'session_opened', subagent, adapter: this.adapter, cwd, title, state: 'IDLE', reconnected })
  }

  /** initialize and session/new (or session/load with a history replay). */
  setup(agentInfo: JsonObject, agentCapabilities: JsonObject, authMethods: JsonValue[], result: JsonObject, cwd: string, replay?: () => void): this {
    const init = this.request('out', 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'subagent-cockpit-mcp', title: 'Subagent Cockpit', version: '0.1.0' },
    })
    this.respond('in', init, { protocolVersion: 1, agentCapabilities, authMethods, agentInfo })
    const created = replay
      ? this.request('out', 'session/load', { sessionId: this.nativeId, cwd, mcpServers: [], _meta: { claudeCode: { options: { extraArgs: { 'add-dir': '/data' } } } } })
      : this.request('out', 'session/new', { cwd, mcpServers: [] })
    replay?.()
    return this.respond('in', created, replay ? result : { sessionId: this.nativeId, ...result })
  }

  /** A prompt turn: `body` produces the agent's output, `end` how the turn ends. */
  /** `end.result` replaces the standard prompt result, for agents that report usage elsewhere. */
  turn(prompt: JsonValue[], body: () => void, end: { internal?: boolean; stop?: string; error?: string; result?: JsonObject } = {}): this {
    const turnId = ++clock.turn
    this.act({ kind: 'turn_started', turn_id: turnId, internal: end.internal ?? false }).state('RUNNING')
    const id = this.request('out', 'session/prompt', { sessionId: this.nativeId, prompt })
    body()
    if (end.error) {
      this.fail('in', id, { code: -32603, message: 'Internal error', data: { details: end.error } })
      this.act({ kind: 'turn_finished', turn_id: turnId, outcome: 'error', error: 'Internal error' })
    } else {
      const stop = end.stop ?? 'end_turn'
      this.respond('in', id, end.result ?? { stopReason: stop, usage: usage(1800 + turnId * 911, 420 + turnId * 37) })
      this.act({ kind: 'turn_finished', turn_id: turnId, outcome: stop === 'cancelled' ? 'cancelled' : 'done', error: null })
    }
    return this.state('IDLE')
  }

  /** A turn that is still running when the demo ends. */
  openTurn(prompt: JsonValue[], body: () => void): this {
    const turnId = ++clock.turn
    this.act({ kind: 'turn_started', turn_id: turnId, internal: false }).state('RUNNING')
    this.request('out', 'session/prompt', { sessionId: this.nativeId, prompt })
    body()
    return this
  }

  rolePrompt(role: string): this {
    return this.turn([text(role)], () => this.say('Understood. I will follow these instructions for this session.'), { internal: true })
  }

  tool(toolCallId: string, fields: JsonObject, sessionUpdate = 'tool_call'): this {
    return this.update({ sessionUpdate, toolCallId, ...fields })
  }

  /** session/request_permission from the agent; returns its JSON-RPC id. */
  permission(toolCallId: string, title: string, kind: string, rawInput: JsonValue): number {
    return this.request('in', 'session/request_permission', {
      sessionId: this.nativeId,
      toolCall: { toolCallId, title, kind, rawInput },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
  }

  close(reason: 'closed' | 'idle' | 'shutdown' | 'exited' | 'deleted'): this {
    return this.state('CLOSED').act({ kind: 'session_closed', reason })
  }
}

const CODEX: AgentFixture = {
  info: { name: 'codex-acp', title: 'Codex', version: '2.2.2' },
  capabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
  auth: [{ id: 'chatgpt', name: 'Login with ChatGPT' }, { id: 'openai-api-key', name: 'Use OPENAI_API_KEY' }],
  session: {
    modes: {
      currentModeId: 'auto',
      availableModes: [
        { id: 'read-only', name: 'Read Only', description: 'Codex can read files and answer questions.' },
        { id: 'auto', name: 'Default', description: 'Codex can read and edit files in the workspace and run commands.' },
        { id: 'full-access', name: 'Full Access', description: 'Codex can edit files outside the workspace and use the network.' },
      ],
    },
    models: {
      currentModelId: 'gpt-5.5/high',
      availableModels: [
        { modelId: 'gpt-5.5/low', name: 'gpt-5.5 (low)' },
        { modelId: 'gpt-5.5/high', name: 'gpt-5.5 (high)' },
      ],
    },
    configOptions: [
      { id: 'mode', name: 'Approval Preset', type: 'select', category: 'mode', currentValue: 'auto', options: [{ value: 'read-only', name: 'Read Only' }, { value: 'auto', name: 'Default' }, { value: 'full-access', name: 'Full Access' }] },
      { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'gpt-5.5', options: [{ value: 'gpt-5.5', name: 'gpt-5.5' }, { value: 'gpt-5.5-mini', name: 'gpt-5.5-mini' }] },
      { id: 'reasoning_effort', name: 'Reasoning Effort', type: 'select', category: 'thought_level', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    ],
  },
}

const CLAUDE_MODES = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept Edits' }, { id: 'plan', name: 'Plan Mode' }, { id: 'bypassPermissions', name: 'Bypass Permissions' }] }
const claudeConfig = (mode: string): JsonObject[] => [
  { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: mode, options: CLAUDE_MODES.availableModes.map(({ id, name }) => ({ value: id, name })) },
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'opus', options: [{ value: 'default', name: 'Default (Sonnet)' }, { value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }] },
  { id: 'thinking', name: 'Extended thinking', type: 'boolean', currentValue: true },
]
const CLAUDE: AgentFixture = {
  info: { name: '@agentclientprotocol/claude-agent-acp', title: 'Claude Agent', version: '0.93.0' },
  capabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} } },
  auth: [{ id: 'claude-login', name: 'Log in with Claude Code', description: 'Run `claude /login` in the terminal' }],
  session: {
    modes: CLAUDE_MODES,
    models: { currentModelId: 'opus', availableModels: [{ modelId: 'default', name: 'Default (Sonnet)' }, { modelId: 'opus', name: 'Opus' }, { modelId: 'haiku', name: 'Haiku' }] },
    configOptions: claudeConfig('default'),
  },
}

const GROK: AgentFixture = {
  info: { name: 'grok', title: 'Grok Build', version: '0.1.30' },
  capabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {} } },
  auth: [{ id: 'xai-api-key', name: 'XAI_API_KEY' }],
  session: { configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'grok-4.3', options: [{ value: 'grok-4.3', name: 'grok-4.3' }, { value: 'grok-code-fast', name: 'grok-code-fast' }] }] },
}

const OPENCODE: AgentFixture = {
  info: { name: 'opencode', title: 'OpenCode', version: '2.0.31' },
  capabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, delete: {} } },
  auth: [],
  session: {
    modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'build' }, { id: 'plan', name: 'plan' }] },
    configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'anthropic/claude-sonnet-4.6', options: [{ group: 'anthropic', name: 'Anthropic', options: [{ value: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' }] }, { group: 'deepseek', name: 'DeepSeek', options: [{ value: 'deepseek/deepseek-v4', name: 'DeepSeek V4' }] }] }],
  },
}

const AGY: AgentFixture = {
  info: { name: 'agy-acp', title: 'Antigravity', version: '0.1.0' },
  capabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: false }, sessionCapabilities: { resume: {} } },
  auth: [],
  session: { configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro' }] }] },
}

const SUMMARY_MARKDOWN = [
  '## Summary',
  '',
  'Input validation is in place for both routes:',
  '',
  '- `POST /users` rejects a missing `email` and a `name` over 80 characters',
  '- `PATCH /users/:id` accepts partial bodies but validates each field it gets',
  '- Errors return **400** with a field list instead of a 500',
  '',
  '| File | Change |',
  '|---|---|',
  '| `src/api/users.ts` | calls `validateUser` before saving |',
  '| `src/api/validate.ts` | new, checks `email` and `name` |',
  '| `test/users.test.ts` | 6 new cases |',
  '',
  '```ts',
  'export function validateUser(input: Partial<User>): string[] {',
  '  const errors: string[] = []',
  '  if (!input.email?.includes(\'@\')) errors.push(\'email\')',
  '  if ((input.name ?? \'\').length > 80) errors.push(\'name\')',
  '  return errors',
  '}',
  '```',
  '',
  'All 48 tests pass.',
].join('\n')

const USERS_BEFORE = 'export async function createUser(req: Request) {\n  const body = await req.json()\n  return db.users.insert(body)\n}\n'
const USERS_AFTER = 'import { validateUser } from \'./validate\'\n\nexport async function createUser(req: Request) {\n  const body = await req.json()\n  const errors = validateUser(body)\n  if (errors.length) return Response.json({ errors }, { status: 400 })\n  return db.users.insert(body)\n}\n'
const VALIDATE_FIRST = 'export function validateUser(input: Partial<User>): string[] {\n  const errors: string[] = []\n  if (!input.email?.includes(\'@\')) errors.push(\'email\')\n  return errors\n}\n'
const VALIDATE_FIXED = 'export function validateUser(input: Partial<User>): string[] {\n  const errors: string[] = []\n  if (!input.email?.includes(\'@\')) errors.push(\'email\')\n  if ((input.name ?? \'\').length > 80) errors.push(\'name\')\n  return errors\n}\n'
const TEST_FAILURE = [
  'FAIL test/users.test.ts',
  '  ✕ rejects a name over 80 characters (4 ms)',
  '',
  '  ● createUser › rejects a name over 80 characters',
  '',
  '    expect(received).toBe(expected)',
  '',
  '    Expected: 400',
  '    Received: 201',
  '',
  '      at test/users.test.ts:31:24',
  '',
  'Tests: 1 failed, 47 passed, 48 total',
].join('\n')

/** codex `Coder`: a believable task end to end, streaming markdown and the three turn endings (D3, D4). */
function coder(): Script {
  const s = new Script('mcp-a', 'codex', '019a6c2e-5b1f-7c33-9a0e-3f1d2b8c4e71')
  s.open('Coder', '/Users/dev/repo').setup(CODEX.info, CODEX.capabilities, CODEX.auth, CODEX.session, '/Users/dev/repo')
  // codex-acp's own structures, read by its parser (D8)
  s.notify('in', '_auth/status_update', { authStatus: { kind: 'gateway', label: 'Custom model gateway', detail: 'OpenAI' } })
  s.update({ sessionUpdate: 'session_info_update', updatedAt: new Date(clock.now).toISOString(), _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } } })
  s.rolePrompt('You are a careful backend engineer. Keep changes small and always run the tests.')
  s.turn([text('Add input validation to `src/api/users.ts` and cover it with tests.')], () => {
    s.say('**Reading the handler**\n\nThe route inserts the body as-is. I should add a validator and wire it in before `db.users.insert`.', null, 40, 'agent_thought_chunk')
    s.say('I\'ll start by reading the handler and its tests.', 'msg-1', 20)
    s.tool('call_read', { title: 'Read src/api/users.ts', kind: 'read', status: 'pending', locations: [{ path: '/Users/dev/repo/src/api/users.ts' }], rawInput: { path: 'src/api/users.ts' } })
    s.tool('call_read', { status: 'completed', content: [{ type: 'content', content: text('```ts\n' + USERS_BEFORE + '```') }], rawOutput: { bytes: 96 } }, 'tool_call_update')
    s.tool('call_grep', { title: 'Search createUser', kind: 'search', status: 'completed', locations: [{ path: '/Users/dev/repo/src/api/users.ts', line: 1 }, { path: '/Users/dev/repo/test/users.test.ts', line: 12 }], rawInput: { pattern: 'createUser', path: '.' }, rawOutput: { matches: 2 } })
    // codex streams command output only as _meta.terminal_output_delta
    s.tool('exec-git', { title: 'git status --short', kind: 'execute', status: 'in_progress', rawInput: { command: ['git', 'status', '--short'] } })
    s.tool('exec-git', { status: 'in_progress', _meta: { terminal_output_delta: { data: ' M src/api/users.ts\n', terminal_id: 'exec-git' } } }, 'tool_call_update')
    s.tool('exec-git', { status: 'completed', rawOutput: { exit_code: 0 }, _meta: { terminal_output_delta: { data: '?? src/api/validate.ts\n', terminal_id: 'exec-git' } } }, 'tool_call_update')
    s.tool('call_edit', { title: 'Edit src/api/users.ts', kind: 'edit', status: 'in_progress', locations: [{ path: '/Users/dev/repo/src/api/users.ts', line: 3 }] })
    s.tool('call_edit', { status: 'completed', content: [{ type: 'diff', path: '/Users/dev/repo/src/api/users.ts', oldText: USERS_BEFORE, newText: USERS_AFTER }] }, 'tool_call_update')
    s.tool('call_new', { title: 'Create src/api/validate.ts', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/Users/dev/repo/src/api/validate.ts', oldText: null, newText: VALIDATE_FIRST }] })
    s.tool('call_test1', { title: 'npm test', kind: 'execute', status: 'failed', content: [{ type: 'content', content: text(TEST_FAILURE) }], rawInput: { command: ['npm', 'test'] }, rawOutput: { exit_code: 1, duration_ms: 5120 } })
    s.say('The long-name case still returns 201: the validator never checks `name`. Adding that rule.', 'msg-1b', 20)
    s.tool('call_fix', { title: 'Edit src/api/validate.ts', kind: 'edit', status: 'completed', locations: [{ path: '/Users/dev/repo/src/api/validate.ts', line: 4 }], content: [{ type: 'diff', path: '/Users/dev/repo/src/api/validate.ts', oldText: VALIDATE_FIRST, newText: VALIDATE_FIXED }] })
    s.tool('call_test2', { title: 'npm test', kind: 'execute', status: 'completed', content: [{ type: 'content', content: text('PASS test/users.test.ts\nTests: 48 passed, 48 total') }], rawInput: { command: ['npm', 'test'] }, rawOutput: { exit_code: 0 } })
    s.say(SUMMARY_MARKDOWN, 'msg-2')
  }, { result: { stopReason: 'end_turn', _meta: { quota: { token_count: { totalTokens: 18545, inputTokens: 8556, cachedInputTokens: 9984, outputTokens: 5 } } } } })
  s.turn([text('Also handle the PATCH route.')], () => {
    s.say('Looking at the PATCH handler now', 'msg-3', 12)
    s.state('RUNNING', true).notify('out', 'session/cancel', { sessionId: s.nativeId })
  }, { stop: 'cancelled' })
  s.turn([text('Retry the PATCH route.')], () => s.say('Retrying…', 'msg-4'), { error: 'stream disconnected before completion: error sending request' })
  s.goLive().turn([text('Summarize what changed.')], () => {
    s.say('The user wants a summary. I will list the files and the test results, then show the new validator.', null, 12, 'agent_thought_chunk')
    s.tool('call_diff', { title: 'git diff --stat', kind: 'execute', status: 'in_progress', rawInput: { command: ['git', 'diff', '--stat'] } })
    s.tool('call_diff', { status: 'completed', content: [{ type: 'content', content: text(' src/api/users.ts    |  5 ++++-\n src/api/validate.ts |  6 ++++++\n test/users.test.ts  | 61 +++++++++++++\n 3 files changed, 71 insertions(+), 1 deletion(-)') }] }, 'tool_call_update')
    s.say(SUMMARY_MARKDOWN, 'msg-5', 24)
  })
  return s
}

/** claude `Reviewer`: reloaded session with a replayed history, session info, and every approval outcome (D2, D3, D6). */
function reviewer(): Script {
  const s = new Script('mcp-a', 'claude', '7c0f9a52-1d3e-4b8a-9f61-2e5d8c4b7a90')
  s.open('Reviewer', '/Users/dev/repo', 'Review auth middleware', true)
  s.setup(CLAUDE.info, CLAUDE.capabilities, CLAUDE.auth, CLAUDE.session, '/Users/dev/repo', () => {
    s.update({ sessionUpdate: 'user_message_chunk', content: text('Review the auth middleware for token handling bugs.') })
    s.say('I found two issues:\n\n1. Expired tokens are accepted when `exp` is missing.\n2. The `Bearer` prefix check is case-sensitive.')
    s.tool('toolu_old', { title: 'Read src/middleware/auth.ts', kind: 'read', status: 'completed', locations: [{ path: '/Users/dev/repo/src/middleware/auth.ts' }], _meta: { claudeCode: { toolName: 'Read' } } })
  })
  s.notify('in', '_auth/status_update', { authStatus: { kind: 'subscription', label: 'Claude subscription' } })
  s.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review a pull request' }, { name: 'compact', description: 'Clear history but keep a summary in context' }, { name: 'init', description: 'Create a CLAUDE.md for this project' }, { name: 'pr-comments', description: 'Get comments from a GitHub pull request' }] })
  s.update({ sessionUpdate: 'usage_update', used: 48213, size: 200000, cost: { amount: 0.42, currency: 'USD' } })
  const set = s.request('out', 'session/set_config_option', { sessionId: s.nativeId, configId: 'mode', value: 'acceptEdits' })
  s.respond('in', set, { configOptions: claudeConfig('acceptEdits') })
  s.update({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' })
  s.turn([text('Fix the two issues you found.')], () => {
    s.say('I\'ll fix the expiry check first.', 'm1')
    s.tool('toolu_01', { title: 'Edit src/middleware/auth.ts', kind: 'edit', status: 'pending', locations: [{ path: '/Users/dev/repo/src/middleware/auth.ts', line: 18 }], _meta: { claudeCode: { toolName: 'Edit' } } })
    const p1 = s.permission('toolu_01', 'Edit src/middleware/auth.ts', 'edit', { file_path: '/Users/dev/repo/src/middleware/auth.ts', old_string: 'if (payload.exp && payload.exp < now)', new_string: 'if (!payload.exp || payload.exp < now)' })
    s.act({ kind: 'approval', approval_id: 'ap_1', tool_call_id: 'toolu_01' }).state('ASKING')
    s.act({ kind: 'approval_resolved', approval_id: 'ap_1', resolution: 'approve', option_id: 'allow' }).respond('out', p1, { outcome: { outcome: 'selected', optionId: 'allow' } }).state('RUNNING')
    s.tool('toolu_01', { status: 'completed', content: [{ type: 'diff', path: '/Users/dev/repo/src/middleware/auth.ts', oldText: '  if (payload.exp && payload.exp < now) {\n', newText: '  if (!payload.exp || payload.exp < now) {\n' }] }, 'tool_call_update')
    const p2 = s.permission('toolu_02', 'npm test', 'execute', { command: 'npm test', description: 'Run the test suite' })
    s.act({ kind: 'approval', approval_id: 'ap_2', tool_call_id: 'toolu_02' }).state('ASKING')
    s.act({ kind: 'approval_resolved', approval_id: 'ap_2', resolution: 'allow', option_id: 'allow' }).respond('out', p2, { outcome: { outcome: 'selected', optionId: 'allow' } }).state('RUNNING')
    const p3 = s.permission('toolu_03', 'npm test', 'execute', { command: 'npm test', description: 'Run the test suite again' })
    s.act({ kind: 'auto_approved', tool_call_id: 'toolu_03', option_id: 'allow' }).respond('out', p3, { outcome: { outcome: 'selected', optionId: 'allow' } })
    const p4 = s.permission('toolu_04', 'rm -rf dist', 'delete', { command: 'rm -rf dist', description: 'Clean the build output' })
    s.act({ kind: 'approval', approval_id: 'ap_3', tool_call_id: 'toolu_04' }).state('ASKING')
    s.act({ kind: 'approval_resolved', approval_id: 'ap_3', resolution: 'reject', option_id: 'reject' }).respond('out', p4, { outcome: { outcome: 'selected', optionId: 'reject' } }).state('RUNNING')
    s.say('Both issues are fixed and the tests pass. I skipped deleting `dist/` since you rejected it.', 'm2')
    s.update({ sessionUpdate: 'usage_update', used: 61022, size: 200000, cost: { amount: 0.57, currency: 'USD' } })
    s.update({ sessionUpdate: 'session_info_update', title: 'Fix auth middleware issues', updatedAt: new Date(clock.now).toISOString() })
  })
  s.turn([text('Now run the full suite with coverage.')], () => {
    const p5 = s.permission('toolu_05', 'npm run test:coverage', 'execute', { command: 'npm run test:coverage' })
    s.act({ kind: 'approval', approval_id: 'ap_4', tool_call_id: 'toolu_05' }).state('ASKING')
    s.act({ kind: 'approval_resolved', approval_id: 'ap_4', resolution: 'cancelled', option_id: null }).respond('out', p5, { outcome: { outcome: 'cancelled' } })
    s.state('RUNNING', true).notify('out', 'session/cancel', { sessionId: s.nativeId })
  }, { stop: 'cancelled' })
  s.goLive().openTurn([text('Commit the fix.')], () => {
    s.say('Committing the two changes.', 'm3')
    s.permission('toolu_06', 'git commit -m "Fix token expiry and Bearer prefix checks"', 'execute', { command: 'git commit -m "Fix token expiry and Bearer prefix checks"' })
    s.act({ kind: 'approval', approval_id: 'ap_5', tool_call_id: 'toolu_06' }).state('ASKING')
  })
  return s
}

/** claude `Planner`: plans, notices, compaction, subagents and session messages (D5); ends cancelling. */
function planner(): Script {
  const s = new Script('mcp-a', 'claude', 'b3e8d1f4-6a2c-4f09-8d37-c51e0a9b2f68')
  s.open('Planner', '/Users/dev/repo').setup(CLAUDE.info, CLAUDE.capabilities, CLAUDE.auth, CLAUDE.session, '/Users/dev/repo')
  s.turn([text('Plan the migration to the new billing API.')], () => {
    s.update({ sessionUpdate: 'plan', entries: [{ content: 'Read the billing SDK changelog', priority: 'high', status: 'completed' }, { content: 'List call sites', priority: 'medium', status: 'in_progress' }, { content: 'Draft the rollout', priority: 'low', status: 'pending' }] })
    s.update({ sessionUpdate: 'notice', severity: 'info', title: 'Using cached repository index', description: 'Index built 3 minutes ago.' })
    s.update({ sessionUpdate: 'plan', entries: [{ content: 'Read the billing SDK changelog', priority: 'high', status: 'completed' }, { content: 'List call sites', priority: 'medium', status: 'completed' }, { content: 'Draft the rollout', priority: 'low', status: 'in_progress' }] })
    s.update({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'migration', entries: [{ content: 'Swap the client constructor', priority: 'high', status: 'in_progress' }, { content: 'Rename `charge()` to `createCharge()`', priority: 'medium', status: 'pending' }] } })
    s.update({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'rollout', content: '### Rollout\n\n1. Ship behind `billing_v2`\n2. Enable for 5% of accounts\n3. Remove the old client after a week' } })
    s.update({ sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'spec', uri: 'file:///Users/dev/repo/docs/billing-migration.md' } })
    s.update({ sessionUpdate: 'notice', severity: 'warning', title: 'Rate limited', description: 'Retrying in 5 seconds.' })
    s.update({ sessionUpdate: 'subagent_update', sessionId: 'sub-7f3a', title: 'Explore billing SDK', description: 'Reads the vendor SDK and lists breaking changes', state: { state: 'running' } })
    s.update({ sessionUpdate: 'session_message', messageId: 'sm-1', senderSessionId: 'sub-7f3a', recipientSessionId: s.nativeId, content: [text('Found 4 breaking changes: constructor options, `charge()` rename, webhook signature v2, idempotency keys now required.')] })
    s.update({ sessionUpdate: 'subagent_update', sessionId: 'sub-7f3a', title: 'Explore billing SDK', state: { state: 'idle' } })
    s.update({ sessionUpdate: 'session_message_chunk', messageId: 'sm-2', senderSessionId: 'sub-7f3a', recipientSessionId: s.nativeId, content: text('Streaming report from the explorer: webhook payloads now nest the charge under `data.object`, ') })
    s.update({ sessionUpdate: 'session_message_chunk', messageId: 'sm-2', senderSessionId: 'sub-7f3a', recipientSessionId: s.nativeId, content: text('and retries reuse the same idempotency key.') })
    s.update({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'migration', entries: [{ content: 'Swap the client constructor', priority: 'high', status: 'completed' }, { content: 'Rename `charge()` to `createCharge()`', priority: 'medium', status: 'in_progress' }] } })
    s.update({ sessionUpdate: 'plan_removed', planId: 'rollout' })
    s.update({ sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'in_progress' })
    s.update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c-1', content: text('Summary so far: the migration touches 14 call sites in 6 files; ') })
    s.update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c-1', content: text('the rollout plan was dropped in favour of a single release.') })
    s.update({ sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'completed', summary: [text('Migration touches 14 call sites in 6 files.')] })
    s.update({ sessionUpdate: 'notice', severity: 'error', title: 'Sandbox unavailable', description: 'Commands will run without the sandbox.' })
    s.say('The plan is ready. The `migration` plan tracks the code changes and the spec file has the details.', 'p1')
  })
  s.goLive().openTurn([text('Start with the constructor swap.')], () => {
    s.say('Starting with `new Billing({ apiKey })`', 'p2', 10)
    s.state('RUNNING', true).notify('out', 'session/cancel', { sessionId: s.nativeId })
  })
  return s
}

/** opencode `Releaser`: every question outcome, including one skipped outside a turn (D6), and a subagent's work (D8); ends waiting on a question. */
function releaser(): Script {
  const s = new Script('mcp-a', 'opencode', 'ses_7a1f3c9e2b4d')
  s.open('Releaser', '/Users/dev/repo').setup(OPENCODE.info, OPENCODE.capabilities, OPENCODE.auth, OPENCODE.session, '/Users/dev/repo')
  const form = (message: string, requestedSchema: JsonObject) => s.request('in', 'elicitation/create', { sessionId: s.nativeId, mode: 'form', message, requestedSchema })
  const skipped = form('Allow anonymous usage statistics?', { type: 'object', properties: { allow: { type: 'boolean' } } })
  s.respond('out', skipped, { action: 'cancel' })
  s.turn([text('Set up the release workflow.')], () => {
    const q1 = form('Which registry should the release publish to?', { type: 'object', properties: { registry: { type: 'string', enum: ['npm', 'github'] }, tag: { type: 'string', title: 'dist-tag' } }, required: ['registry'] })
    s.act({ kind: 'question', question_id: 'qu_1' }).state('QUESTIONING')
    s.act({ kind: 'question_resolved', question_id: 'qu_1', action: 'accept' }).respond('out', q1, { action: 'accept', content: { registry: 'npm', tag: 'next' } }).state('RUNNING')
    const q2 = form('Also create a GitHub release?', { type: 'object', properties: { create: { type: 'boolean' } } })
    s.act({ kind: 'question', question_id: 'qu_2' }).state('QUESTIONING')
    s.act({ kind: 'question_resolved', question_id: 'qu_2', action: 'decline' }).respond('out', q2, { action: 'decline' }).state('RUNNING')
    const q3 = form('Pick the changelog format', { type: 'object', properties: { format: { type: 'string', enum: ['keep-a-changelog', 'conventional'] } } })
    s.act({ kind: 'question', question_id: 'qu_3' }).state('QUESTIONING')
    s.act({ kind: 'question_resolved', question_id: 'qu_3', action: 'cancel' }).respond('out', q3, { action: 'cancel' }).state('RUNNING')
    // OpenCode streams its subagent's work into this session, each update marked with the child session (D8). As
    // opencode 2.0.30 sends it: the subagent's tool titles start with the task description, and the task finishes last
    const childId = 'ses_ea1a761afffeOFDfr7S7qNjbgO'
    const child = { _meta: { 'opencode/child-session': { id: childId, parentID: s.nativeId, depth: 1, title: 'Check existing workflows' } } }
    const reply = 'Only `ci.yml` exists; it runs the tests on push and has no publish job.'
    s.tool('call_d7f513bb', { title: 'subagent', name: 'subagent', kind: 'think', status: 'pending', rawInput: {} })
    s.tool('call_d7f513bb', { status: 'in_progress', rawInput: { agent: 'general', description: 'Check existing workflows', prompt: 'List the workflows in .github/workflows and say whether any of them publishes a release.' } }, 'tool_call_update')
    s.tool(`${childId}:call_2c0bbf64`, { title: 'Check existing workflows: read', name: 'read', kind: 'read', status: 'completed', locations: [{ path: '/Users/dev/repo/.github/workflows/ci.yml' }], rawInput: { path: '.github/workflows/ci.yml' }, ...child })
    s.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'msg_15e58a6bb0013jqe:reasoning:0', content: text('**Checking for a publish job**'), ...child })
    s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_15e58bbce001WkOi', content: text('Only `ci.yml` exists; '), ...child })
    s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_15e58bbce001WkOi', content: text('it runs the tests on push and has no publish job.'), ...child })
    s.tool('call_d7f513bb', {
      status: 'completed',
      content: [{ type: 'content', content: text(`<subagent sessionID="${childId}" state="completed">\n${reply}\n</subagent>`) }],
      rawOutput: { metadata: { sessionID: childId, status: 'completed', truncated: false } },
    }, 'tool_call_update')
    s.say('Added `.github/workflows/release.yml` publishing to npm with the `next` tag.', 'o1')
  })
  s.goLive().openTurn([text('Bump the version.')], () => {
    form('Which version bump?', {
      type: 'object',
      properties: {
        bump: { type: 'string', title: 'Version bump', description: 'Follows semver from 1.4.2', oneOf: [{ const: 'patch', title: 'Patch (1.4.3)' }, { const: 'minor', title: 'Minor (1.5.0)' }, { const: 'major', title: 'Major (2.0.0)' }] },
        dry_run: { type: 'boolean', title: 'Dry run' },
      },
      required: ['bump'],
    })
    s.act({ kind: 'question', question_id: 'qu_4' }).state('QUESTIONING')
  })
  return s
}

/** grok `Inspector`: content blocks, rare tool shapes, errors both ways, truncation, unknown updates and extension methods (D4, D7). */
function inspector(): Script {
  const s = new Script('mcp-a', 'grok', 'grok-01k2x9v7m4')
  s.open('Inspector', '/Users/dev/repo').setup(GROK.info, GROK.capabilities, GROK.auth, GROK.session, '/Users/dev/repo')
  /** grok wraps its own session updates in this extension notification */
  const grokNote = (update: JsonObject) => s.notify('in', '_x.ai/session_notification', { sessionId: s.nativeId, update, _meta: { agentTimestampMs: clock.now } })
  const bad = s.request('out', 'session/set_config_option', { sessionId: s.nativeId, configId: 'model', value: 'grok-9' })
  s.fail('in', bad, { code: -32602, message: 'Invalid params', data: { configId: 'model', value: 'grok-9', allowed: ['grok-4.3', 'grok-code-fast'] } })
  s.turn([
    text('Describe the attached screenshot and compare it with the spec.'),
    { type: 'resource_link', name: 'billing-migration.md', title: 'Migration spec', uri: 'file:///Users/dev/repo/docs/billing-migration.md', mimeType: 'text/markdown', size: 18342, description: 'Design notes' },
    { type: 'resource', resource: { uri: 'file:///Users/dev/repo/src/config.ts', mimeType: 'text/typescript', text: 'export const config = {\n  billing: { version: 2 },\n}\n' } },
    { type: 'resource', resource: { uri: 'file:///Users/dev/repo/assets/logo.bin', mimeType: 'application/octet-stream', blob: 'AAECAwQFBgcICQ==' } },
  ], () => {
    // Tool shapes a well-behaved agent rarely sends: terminal content, an update without its tool_call, no status
    s.tool('call_term', { title: 'npm run dev', kind: 'execute', status: 'in_progress', content: [{ type: 'terminal', terminalId: 'term-7' }] })
    s.tool('call_orphan', { status: 'completed', title: 'Fetch https://json-schema.org/draft/2020-12', kind: 'fetch' }, 'tool_call_update')
    s.tool('call_think', { title: 'Check edge cases', kind: 'think', status: 'completed' })
    s.tool('call_note', { title: 'Note the follow-up', kind: 'other' })
    // grok's own structures, read by its parser (D8): a hook as an event, repeats and internal syncing on the protocol log only
    grokNote({ sessionUpdate: 'hook_execution', event_name: 'session_start', runs: [{ name: 'plugin/team-rules:session_start', status: { status: 'success', elapsed_ms: 95 } }] })
    grokNote({ sessionUpdate: 'tool_call_delta_chunk', tool_call_id: 'call_term', tool_index: 0, name: 'run_command' })
    grokNote({ sessionUpdate: 'pending_interaction', tool_call_id: 'call_term', kind: 'permission' })
    grokNote({ sessionUpdate: 'interaction_resolved', tool_call_id: 'call_term' })
    grokNote({ sessionUpdate: 'response_completed', usage: { input_tokens: 24600, output_tokens: 304 } })
    s.notify('in', '_x.ai/session/setup', { method: 'session/prompt', phase: 'ready', sessionId: s.nativeId })
    s.notify('in', '_x.ai/queue/changed', { sessionId: s.nativeId, entries: [] })
    s.notify('in', '_x.ai/sessions/changed', { upserted: [{ sessionId: s.nativeId, activity: 'working' }], removed: [] })
    const read = s.request('in', 'fs/read_text_file', { sessionId: s.nativeId, path: '/Users/dev/repo/README.md' })
    s.fail('out', read, { code: -32601, message: 'Method not found', data: { method: 'fs/read_text_file' } })
    s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'g1', content: text('Here is the rendered chart and a voice note:') })
    s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'g1', content: { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iOTAiPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iOTAiIGZpbGw9IiMxNjc3ZmYiLz48dGV4dCB4PSIxNiIgeT0iNTAiIGZpbGw9IiNmZmYiIGZvbnQtc2l6ZT0iMTgiPmNoYXJ0LnN2ZzwvdGV4dD48L3N2Zz4=' } })
    s.update({ sessionUpdate: 'agent_message_chunk', messageId: 'g1', content: { type: 'audio', mimeType: 'audio/wav', data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=' } })
    s.send('in', { truncated: true, bytes: 3_456_789, method: 'session/update', id: null })
    s.update({ sessionUpdate: 'usage_breakdown', byModel: { 'grok-4.3': { input: 12000, output: 900 } } })
    s.notify('in', '_x.ai/session/telemetry', { sessionId: s.nativeId, tokensPerSecond: 182.4 })
    s.respond('in', 99, { orphan: true })
    s.say('The screenshot matches the spec except for the currency column.', 'g2')
    grokNote({ sessionUpdate: 'last_turn_summary', summary: 'Screenshot matches the spec except the currency column', prompt_id: 'p-1' })
    grokNote({ sessionUpdate: 'turn_completed', prompt_id: 'p-1', stop_reason: 'end_turn', usage: { totalTokens: 25096 } })
    s.notify('in', '_x.ai/session/prompt_complete', { sessionId: s.nativeId, promptId: 'p-1', stopReason: 'end_turn', agentResult: null })
  })
  grokNote({ sessionUpdate: 'session_summary_generated', session_summary: 'Screenshot review against the billing spec' })
  const del = s.request('out', '_x.ai/session/delete', { sessionId: s.nativeId })
  s.respond('in', del, {})
  return s.close('idle')
}

/** A short finished session, for the list's ended states. */
function short(mcp: string, adapter: string, nativeId: string, subagent: string, agent: AgentFixture, prompt: string, end: 'closed' | 'shutdown' | 'exited' | 'deleted' | null): Script {
  const s = new Script(mcp, adapter, nativeId)
  const cwd = mcp === 'mcp-a' ? '/Users/dev/repo' : '/Users/dev/web'
  s.open(subagent, cwd).setup(agent.info, agent.capabilities, agent.auth, agent.session, cwd)
  s.turn([text(prompt)], () => s.say(`Done: ${prompt.toLowerCase()}`, 'x1'))
  end && s.close(end)
  return s
}

function scripts(): Script[] {
  return [
    coder(),
    reviewer(),
    planner(),
    releaser(),
    inspector(),
    short('mcp-a', 'antigravity', '9e1c4f2a-agy', 'Writer', AGY, 'Draft release notes', 'closed'),
    short('mcp-a', 'codex', '019a6b11-0c2d-7e44-8b1a-5f3e9d2c1a07', 'Cleanup', CODEX, 'Remove dead feature flags', 'deleted'),
    short('mcp-b', 'codex', '019a6d40-2e7b-7f10-9c3d-8a1b5e6f2c94', 'Coder', CODEX, 'Fix the navbar overflow', 'shutdown'),
    short('mcp-b', 'claude', '5e2a7c1d-9b4f-4e63-a8d0-1f7c3b9e6a25', 'Reviewer', CLAUDE, 'Review the navbar fix', 'exited'),
    short('mcp-b', 'grok', 'grok-01k2xa3p8q', 'Inspector', GROK, 'Fix lint warnings', null),
  ]
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const send = (socket: WebSocket, message: McpToWebui) => socket.send(JSON.stringify(message))

/** What answers /api/ping on the port; null when nothing listens or the answer is not JSON. */
async function ping(): Promise<Partial<WebuiPingResult> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(1000) })
    return JSON.parse(await res.text())
  } catch {
    // Refused, timed out or not JSON: nothing usable is listening
    return null
  }
}

/** Wait until the webui we started answers, so the mock never talks to another process. */
async function awaitWebui(pid: number | undefined, deadline: number): Promise<void> {
  const answer = await ping()
  if (answer?.name === WEBUI_NAME && answer.pid === pid) return
  if (Date.now() > deadline) throw new Error(`webui did not start on port ${PORT}`)
  await sleep(200)
  return awaitWebui(pid, deadline)
}

/** One fake MCP server: a WebSocket without Origin, then hello and client, as src/webui/link.ts sends them. */
async function connect({ pid, cwd, client }: FakeMcp): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/mcp`)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  send(socket, { type: 'hello', pid, cwd, version: '0.1.0', started_at: STARTED_AT })
  send(socket, { type: 'client', ...client })
  return socket
}

async function main(): Promise<void> {
  // Whatever already listens may be the real webui: fake sessions must never reach it
  if (await ping()) throw new Error(`port ${PORT} is taken; set COCKPIT_MOCK_WEBUI_PORT to a free port`)
  const webui = spawn(process.execPath, [WEBUI, '--port', String(PORT)], { stdio: 'inherit' })
  process.once('exit', () => webui.kill())
  await awaitWebui(webui.pid, Date.now() + 5000)

  const sockets = new Map(await Promise.all(MCPS.map(async (mcp): Promise<[string, WebSocket]> => [mcp.id, await connect(mcp)])))
  const deliver = ({ mcp, session, at, activity }: Event) => {
    const socket = sockets.get(mcp)
    socket?.readyState === WebSocket.OPEN && send(socket, { type: 'activity', session, at, activity })
  }
  const all = scripts()
  all.flatMap(s => s.events).forEach(deliver)
  sockets.get('mcp-b')?.close()
  const live = all.flatMap(s => s.live)
  REPLAY_INTERVAL_MS === 0 && live.splice(0).forEach(deliver)
  process.stdout.write(`webui mock: http://127.0.0.1:${PORT}  (Ctrl+C to stop)\n`)

  // mcp-a stays connected after the live part, which keeps the webui up until Ctrl+C
  const timer = setInterval(() => {
    const next = live.shift()
    next ? deliver(next) : clearInterval(timer)
  }, REPLAY_INTERVAL_MS || 1)
}

main().catch((err: Error) => {
  process.stderr.write(`webui mock: ${err.message}\n`)
  process.exit(1)
})
