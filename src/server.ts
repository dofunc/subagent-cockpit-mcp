import { resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolRequest, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { CockpitError } from './adapter/adapter'
import type { ApprovalVerb } from './adapter/adapter'
import type { ConversationStore } from './conversation-store'
import type { SessionManager } from './session/session-manager'
import type { AnswerAction, AnswerContent, ConversationItemKind, ItemResult, SnapshotItem, SnapshotResult } from './types'

type Args = NonNullable<CallToolRequest['params']['arguments']>
type Handler = (args: Args, signal: AbortSignal) => Promise<object> | object
type JsonSchema = Record<string, unknown>

/** One tool param. The same definition gives the inputSchema and the check checkArgs runs. */
interface Param {
  type: 'string' | 'boolean' | 'number' | 'integer' | 'array' | 'object'
  description?: string
  /** Allowed values of a string param; anything else is Invalid params */
  enum?: string[]
  /** Smallest allowed value of a number or integer param */
  minimum?: number
  /** Allowed values of an array param's elements, which are strings */
  items?: { enum: string[] }
}

interface ToolSpec {
  name: string
  description: string
  params: Record<string, Param>
  required?: string[]
  output: JsonSchema
  /** Waits for the agent; gets progress heartbeats while waiting. */
  blocking?: boolean
}

export interface ServerOptions {
  /** Interval of progress notifications during a blocking call. */
  heartbeatMs?: number
  log?: (message: string) => void
}

const HEARTBEAT_MS = 60_000

const BLOCKING_RULES = 'Blocks until the turn is done, needs an approval or asks a question; the server sets no time limit. If your client times out, the turn keeps running and the connection stays: call `status` for the state and `output` for the reply instead of sending the task again. Returns "approval_needed" with an approval to answer via approve / allow / reject, or "question_needed" with a question to answer via answer.'

// ── Schemas ──

const str: JsonSchema = { type: 'string' }
const num: JsonSchema = { type: 'number' }
const bool: JsonSchema = { type: 'boolean' }
const nullable = (type: string): JsonSchema => ({ type: [type, 'null'] })
const oneOf = (...values: string[]): JsonSchema => ({ type: 'string', enum: values })
const list = (items: JsonSchema): JsonSchema => ({ type: 'array', items })

function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required }
}

const STATE = oneOf('OPENING', 'IDLE', 'RUNNING', 'ASKING', 'QUESTIONING', 'CLOSED')

const APPROVAL = object({
  approval_id: str,
  tool_call_id: str,
  title: str,
  kind: nullable('string'),
  options: list(object({ option_id: str, name: str, kind: str }, ['option_id', 'name', 'kind'])),
}, ['approval_id', 'tool_call_id', 'title', 'kind', 'options'])

const CONFIG_OPTIONS = list(object({
  id: str,
  name: str,
  category: nullable('string'),
  type: oneOf('select', 'boolean'),
  current_value: { type: ['string', 'boolean'] },
  options: list(object({ value: str, name: str }, ['value', 'name'])),
}, ['id', 'name', 'category', 'type', 'current_value', 'options']))

const QUESTION = object({
  question_id: str,
  tool_call_id: nullable('string'),
  message: str,
  requested_schema: { type: 'object' },
}, ['question_id', 'tool_call_id', 'message', 'requested_schema'])

const PLAN = list(object({ content: str, priority: str, status: str }, ['content', 'priority', 'status']))

const USAGE: JsonSchema = {
  type: ['object', 'null'],
  properties: { used: num, size: num, cost: { type: ['object', 'null'], properties: { amount: num, currency: str } } },
  required: ['used', 'size', 'cost'],
}

const PROMPT_RESULT = {
  status: oneOf('done', 'approval_needed', 'question_needed', 'running'),
  turn_id: num,
  outcome: oneOf('done', 'cancelled', 'error'),
  output: str,
  approval: APPROVAL,
  question: QUESTION,
}

const SESSION_STATE = {
  session: str,
  state: STATE,
  cancelling: bool,
  subagent: str,
  cwd: str,
  approvals: list(APPROVAL),
  questions: list(QUESTION),
  waiting: bool,
}

const PROGRESS = {
  plan: PLAN,
  usage: USAGE,
  title: nullable('string'),
  commands: list(object({ name: str, description: str }, ['name', 'description'])),
}

const ANSWER_ACTIONS: AnswerAction[] = ['accept', 'decline', 'cancel']

const SESSION_STATE_KEYS = Object.keys(SESSION_STATE)

const ITEM_KINDS: ConversationItemKind[] = [
  'prompt', 'message', 'thought', 'user_message', 'session_message', 'compaction',
  'tool', 'plan', 'approval', 'question', 'notice', 'subagent', 'error', 'turn', 'event', 'raw',
]

const SNAPSHOT_ITEM = object({
  id: str,
  kind: oneOf(...ITEM_KINDS),
  at: num,
  turn_id: nullable('number'),
  data: { type: 'object' },
  rev: num,
}, ['id', 'kind', 'at', 'turn_id', 'data', 'rev'])

const ITEM_KIND_LIST: Param = { type: 'array', items: { enum: ITEM_KINDS }, description: `Conversation item kinds: ${ITEM_KINDS.join(', ')}` }

const SNAPSHOT_DESCRIPTION = [
  'Full conversation of open sessions, the same as the webui shows: prompts, replies, thinking, tool calls with',
  'their input, output and diffs, plans, approvals, questions and agent-specific messages, plus each session\'s',
  'state and pending notifications. It can be large: pass session, and use last, types or exclude_types to keep',
  'it small. Pass back server_id and seq as since to get only what changed. ack is for UI clients that relay',
  'notifications. UI clients that poll: pass simplify to leave out tool call details (input, output, content) and',
  'session commands, and get one item in full with item.',
].join(' ')

const ITEM_DESCRIPTION = [
  'One conversation item in full, by the id snapshot gave it: a tool call with its input, output and diffs,',
  'or any other item. For UI clients that poll snapshot with simplify and show details on demand.',
].join(' ')

/** What the webui shows of a collapsed tool call: the card's label (ToolCallCard.tsx) and the bubble header (child_session). */
const TOOL_HEADER_FIELDS = ['sessionUpdate', 'toolCallId', 'title', 'kind', 'status', 'tool_name', 'subagent_state', 'locations', 'child_session']

// ── Tools ──

const session: Param = { type: 'string', description: 'Session id returned by open' }
const approvalId: Param = { type: 'string', description: 'approval_id from the approval_needed result' }
const wait: Param = { type: 'boolean', description: 'Wait for the result (default true). false returns right after sending.' }

const SPECS: ToolSpec[] = [
  {
    name: 'subagents',
    description: 'List configured subagents.',
    params: {},
    output: object({ subagents: list(object({ name: str, adapter: str, description: str, profile: str })) }, ['subagents']),
  },
  {
    name: 'sessions',
    description: 'List sessions on disk, most recent first, with state, title, last_prompt and last_at. Use it to find a session id after an interrupted open.',
    params: { cwd: { type: 'string' }, status: { type: 'string', description: 'OPENING | IDLE | RUNNING | ASKING | QUESTIONING | CLOSED' } },
    output: object({
      sessions: list(object({
        session: str, subagent: str, cwd: str, role: str, state: STATE, in_use: bool, created_at: str, last_prompt: str, last_at: str, title: str,
      })),
    }, ['sessions']),
  },
  {
    name: 'open',
    description: 'Open a session: reconnect when `session` is given; with `reuse`, take this server\'s idle session with the same cwd and subagent, else reconnect the latest closed one on disk; otherwise create one. A reuse that cannot reconnect creates a new session and says why in reuse_skipped. Reconnecting puts back the config the session last had (the subagent config, or later set_config changes). Returns once the session is set up (role prompt included), with the session id and the full config_options. It takes no task: send tasks with `prompt`.',
    params: {
      subagent: { type: 'string' },
      cwd: { type: 'string', description: 'Working directory of the agent' },
      session,
      reuse: { type: 'boolean' },
      role: { type: 'string', description: 'Identity for the session. Avoid imperative verbs.' },
    },
    required: ['subagent', 'cwd'],
    output: object({
      session: str,
      reused: bool,
      ...PROMPT_RESULT,
      config_options: CONFIG_OPTIONS,
      reuse_skipped: object({ session: str, code: str, message: str }, ['session', 'code', 'message']),
    }, ['session', 'reused', 'status', 'config_options']),
    blocking: true,
  },
  {
    name: 'prompt',
    description: `Send a task to an IDLE session. In ASKING or QUESTIONING it returns the pending approval or question instead. A session closed for idleness is reopened first. ${BLOCKING_RULES}`,
    params: { session, text: { type: 'string' }, wait },
    required: ['session', 'text'],
    output: object(PROMPT_RESULT, ['status']),
    blocking: true,
  },
  {
    name: 'approve',
    description: `Allow this one tool call (allow_once), or pick option_id explicitly. ${BLOCKING_RULES}`,
    params: { session, approval_id: approvalId, option_id: { type: 'string' }, wait },
    required: ['session', 'approval_id'],
    output: object(PROMPT_RESULT, ['status']),
    blocking: true,
  },
  {
    name: 'allow',
    description: `Allow and stop asking for similar calls in this session only. Uses the agent's session-scoped option when it offers one; otherwise this server allows once and answers matching requests itself until the session closes. Never writes a persistent agent rule. ${BLOCKING_RULES}`,
    params: { session, approval_id: approvalId, wait },
    required: ['session', 'approval_id'],
    output: object(PROMPT_RESULT, ['status']),
    blocking: true,
  },
  {
    name: 'reject',
    description: `Reject this tool call (reject_once). Codex and Claude Code continue the turn; Grok and OpenCode end it as cancelled. ${BLOCKING_RULES}`,
    params: { session, approval_id: approvalId, wait },
    required: ['session', 'approval_id'],
    output: object(PROMPT_RESULT, ['status']),
    blocking: true,
  },
  {
    name: 'answer',
    description: `Answer a question the agent asked (question_needed). requested_schema is the agent's own form, passed on as sent: with action "accept" (the default), give content as an object whose keys and values follow it. "decline" refuses to answer, "cancel" dismisses the question. ${BLOCKING_RULES}`,
    params: {
      session,
      question_id: { type: 'string', description: 'question_id from the question_needed result' },
      action: { type: 'string', enum: ANSWER_ACTIONS, description: 'accept (default), decline or cancel' },
      content: { type: 'object', description: 'Field values for accept: string, number, boolean or an array of strings' },
      wait,
    },
    required: ['session', 'question_id'],
    output: object(PROMPT_RESULT, ['status']),
    blocking: true,
  },
  {
    name: 'cancel',
    description: 'Cancel the current turn. Returns "cancelling" until the agent confirms, or "done" when already idle.',
    params: { session },
    required: ['session'],
    output: object({ status: oneOf('cancelling', 'done') }, ['status']),
  },
  {
    name: 'set_config',
    description: 'Change a session config option (model, reasoning_effort, mode, ...). Returns the full config_options. Unknown ids or values fail with the available choices. A session closed for idleness is reopened first.',
    params: { session, config_id: { type: 'string' }, value: { type: 'string' } },
    required: ['session', 'config_id', 'value'],
    output: object({ config_options: CONFIG_OPTIONS }, ['config_options']),
  },
  {
    name: 'status',
    description: 'Session state, cancelling flag, current config values, pending approvals and questions, and whether a blocking call is waiting. Cheap to call repeatedly; the config choices are in open, set_config and snapshot. A session closed for idleness reports CLOSED with its last values.',
    params: { session },
    required: ['session'],
    output: object({ ...SESSION_STATE, config: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } } }, [...SESSION_STATE_KEYS, 'config']),
  },
  {
    name: 'progress',
    description: 'The agent\'s latest execution feedback: its plan, context usage, session title and slash commands. Not needed to run a task; call it only when you want to know. Cheap, never blocks.',
    params: { session },
    required: ['session'],
    output: object(PROGRESS, Object.keys(PROGRESS)),
  },
  {
    name: 'output',
    description: 'Final reply of the most recent turn.',
    params: { session },
    required: ['session'],
    output: object({ turn_id: nullable('number'), output: str }, ['turn_id', 'output']),
  },
  {
    name: 'close',
    description: 'Close a session, or all sessions of this server when session is omitted. Session history is kept.',
    params: { session },
    output: object({ closed: list(str) }, ['closed']),
  },
  {
    name: 'delete',
    description: 'Delete a session and its native agent session (deleted / archived / unsupported).',
    params: { session },
    required: ['session'],
    output: object({ session: str, native: oneOf('deleted', 'archived', 'unsupported') }, ['session', 'native']),
  },
  {
    name: 'snapshot',
    description: SNAPSHOT_DESCRIPTION,
    params: {
      session: { type: 'string', description: 'Only this session' },
      since: { type: 'number', description: 'seq from the previous call: only items changed after it' },
      server_id: { type: 'string', description: 'server_id from the previous call; a different one resets' },
      ack: { type: 'array', description: 'Notification keys already relayed' },
      types: { ...ITEM_KIND_LIST, description: 'Only these item kinds' },
      exclude_types: { ...ITEM_KIND_LIST, description: 'Leave these item kinds out' },
      last: { type: 'integer', minimum: 1, description: 'Only the last n items, after the kind filters' },
      simplify: { type: 'boolean', description: 'Tool items keep only their title, status and other header fields; commands are left out' },
    },
    output: object({
      server_id: str,
      seq: num,
      reset: bool,
      sessions: list(object({
        ...SESSION_STATE,
        ...PROGRESS,
        config_options: CONFIG_OPTIONS,
        notifications: list(object({
          key: str, type: oneOf('turn', 'approval', 'question'), turn_id: num, outcome: oneOf('done', 'cancelled', 'error'), approval: APPROVAL, question: QUESTION,
        }, ['key', 'type'])),
        items: list(SNAPSHOT_ITEM),
      }, [...SESSION_STATE_KEYS, ...Object.keys(PROGRESS).filter(key => key !== 'commands'), 'config_options', 'notifications', 'items'])),
    }, ['server_id', 'seq', 'reset', 'sessions']),
  },
  {
    name: 'item',
    description: ITEM_DESCRIPTION,
    params: { session, id: { type: 'string', description: 'Item id from snapshot' } },
    required: ['session', 'id'],
    output: object({ item: SNAPSHOT_ITEM }, ['item']),
  },
]

function toTool(spec: ToolSpec): Tool {
  const properties = Object.fromEntries(Object.entries(spec.params).map(([key, param]) => [
    key,
    param.type === 'array' ? { ...param, items: { type: 'string', ...param.items } } : param,
  ]))
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { type: 'object', properties, required: spec.required ?? [], additionalProperties: false },
    outputSchema: { type: 'object', ...spec.output },
  }
}

const TOOLS = SPECS.map(toTool)
const SPEC_BY_NAME = new Map(SPECS.map(s => [s.name, s]))

// ── Arguments ──

function matches(param: Param, value: unknown): boolean {
  if (param.type === 'array') return Array.isArray(value) && value.every(v => typeof v === 'string')
  if (param.type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  if (param.type === 'integer') return Number.isInteger(value)
  return typeof value === param.type
}

/** What is wrong with a value of the right type: out of its enum, its elements' enum or below its minimum. */
function outOfRange(param: Param, value: unknown): string | undefined {
  if (param.enum && typeof value === 'string' && !param.enum.includes(value)) return `must be one of ${param.enum.join(', ')}`
  if (param.items && Array.isArray(value) && value.some(v => typeof v !== 'string' || !param.items?.enum.includes(v))) return `items must be one of ${param.items.enum.join(', ')}`
  if (param.minimum !== undefined && typeof value === 'number' && value < param.minimum) return `must be at least ${param.minimum}`
  return undefined
}

/** Reject unknown, missing, mistyped and out-of-range arguments as JSON-RPC Invalid params. null counts as absent. */
function checkArgs(spec: ToolSpec, args: Args): void {
  const present = Object.entries(args).filter(([, v]) => v !== undefined && v !== null)
  const known = present.filter(([k]) => spec.params[k])
  const typed = known.filter(([k, v]) => matches(spec.params[k], v))
  const problems = [
    ...present.filter(([k]) => !spec.params[k]).map(([k]) => `unknown parameter: ${k}`),
    ...(spec.required ?? []).filter(k => !present.some(([p]) => p === k)).map(k => `missing parameter: ${k}`),
    ...known.filter(([k, v]) => !matches(spec.params[k], v)).map(([k]) => `${k} must be ${spec.params[k].type}`),
    ...typed.flatMap(([k, v]) => {
      const problem = outOfRange(spec.params[k], v)
      return problem ? [`${k} ${problem}`] : []
    }),
  ]
  if (problems.length) throw new McpError(ErrorCode.InvalidParams, `${spec.name}: ${problems.join('; ')}`)
}

function isContentValue(value: unknown): value is AnswerContent[string] {
  return ['string', 'number', 'boolean'].includes(typeof value) || (Array.isArray(value) && value.every(v => typeof v === 'string'))
}

/** Values of `content`, which ACP limits to strings, numbers, booleans and string arrays. Anything else is Invalid params. */
function answerContent(args: Args): AnswerContent | undefined {
  const value = args.content
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  const invalid = entries.filter(([, v]) => !isContentValue(v)).map(([k]) => `content.${k}`)
  if (invalid.length) throw new McpError(ErrorCode.InvalidParams, `answer: ${invalid.join(', ')} must be a string, number, boolean or string array`)
  return entries.reduce<AnswerContent>((content, [k, v]) => (isContentValue(v) ? { ...content, [k]: v } : content), {})
}

function optStr(args: Args, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** Present after checkArgs; the fallback only satisfies the type checker. */
function reqStr(args: Args, key: string): string {
  return optStr(args, key) ?? ''
}

function optBool(args: Args, key: string, fallback: boolean): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

function optNum(args: Args, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' ? value : undefined
}

function optStrList(args: Args, key: string): string[] | undefined {
  const value = args[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
}

/** Item kinds of a list param; checkArgs already matched every element against ITEM_KINDS. */
function optKinds(args: Args, key: string): ConversationItemKind[] | undefined {
  const value = optStrList(args, key)
  return value && ITEM_KINDS.filter(kind => value.includes(kind))
}

/** Keep the kinds in `types` (all when absent), drop those in `exclude`, then take the last `last`. */
function pick(items: SnapshotItem[], types: ConversationItemKind[] | undefined, exclude: ConversationItemKind[] | undefined, last: number | undefined): SnapshotItem[] {
  const kept = items.filter(item => (!types || types.includes(item.kind)) && !exclude?.includes(item.kind))
  return last === undefined ? kept : kept.slice(-last)
}

/**
 * `snapshot`: state and notifications from the SessionManager, conversation items from the store. reset is decided
 * once for every selected session: no since, another server_id, or any of them lost items to the retention limit
 * after since. Filters touch only the items, never seq or reset.
 */
function snapshot(manager: SessionManager, store: ConversationStore, args: Args): SnapshotResult {
  const since = optNum(args, 'since')
  const base = manager.snapshot({ session: optStr(args, 'session'), since, server_id: optStr(args, 'server_id'), ack: optStrList(args, 'ack') })
  const reset = since === undefined || optStr(args, 'server_id') !== base.server_id || base.sessions.some(s => store.lostSince(s.session, since))
  const [types, exclude, last] = [optKinds(args, 'types'), optKinds(args, 'exclude_types'), optNum(args, 'last')]
  const simplify = optBool(args, 'simplify', false)
  const sessions = base.sessions.map(({ commands, ...s }) => {
    const items = pick(store.items(s.session, reset ? undefined : since), types, exclude, last)
    return simplify ? { ...s, items: items.map(toolHeader) } : { ...s, commands, items }
  })
  return { server_id: base.server_id, seq: store.seq, reset, sessions }
}

/** A tool item cut down to what its collapsed card shows; the details come one item at a time from `item`. */
function toolHeader(item: SnapshotItem): SnapshotItem {
  if (item.kind !== 'tool') return item
  return { ...item, data: Object.fromEntries(Object.entries(item.data).filter(([key]) => TOOL_HEADER_FIELDS.includes(key))) }
}

/** `item`: one item of an open session in full, as a snapshot without simplify has it. Reads only, acks nothing. */
function item(manager: SessionManager, store: ConversationStore, args: Args): ItemResult {
  const [session, id] = [reqStr(args, 'session'), reqStr(args, 'id')]
  // The same check as snapshot's session: SESSION_NOT_FOUND unless the session is open in this server
  manager.snapshot({ session })
  const found = store.item(session, id)
  if (!found) throw new CockpitError('ITEM_NOT_FOUND', `No item ${id} in session ${session}`)
  return { item: found }
}

// ── Handlers ──

function respond(manager: SessionManager, verb: ApprovalVerb): Handler {
  return (args, signal) => manager.respond(
    verb,
    reqStr(args, 'session'),
    reqStr(args, 'approval_id'),
    verb === 'approve' ? optStr(args, 'option_id') : undefined,
    optBool(args, 'wait', true),
    signal,
  )
}

function handlers(manager: SessionManager, store: ConversationStore): Record<string, Handler> {
  return {
    subagents: () => ({ subagents: manager.subagents() }),
    sessions: async args => {
      const cwd = optStr(args, 'cwd')
      return { sessions: await manager.list(cwd && resolve(cwd), optStr(args, 'status')) }
    },
    open: (args, signal) => manager.open({
      subagent: reqStr(args, 'subagent'),
      cwd: resolve(reqStr(args, 'cwd')),
      session: optStr(args, 'session'),
      reuse: optBool(args, 'reuse', false),
      role: optStr(args, 'role'),
    }, signal),
    prompt: (args, signal) => manager.prompt(reqStr(args, 'session'), reqStr(args, 'text'), optBool(args, 'wait', true), signal),
    approve: respond(manager, 'approve'),
    allow: respond(manager, 'allow'),
    reject: respond(manager, 'reject'),
    answer: (args, signal) => manager.answer(
      reqStr(args, 'session'),
      reqStr(args, 'question_id'),
      ANSWER_ACTIONS.find(a => a === optStr(args, 'action')) ?? 'accept',
      answerContent(args),
      optBool(args, 'wait', true),
      signal,
    ),
    cancel: args => manager.cancel(reqStr(args, 'session')),
    set_config: async (args, signal) => ({
      config_options: await manager.setConfig(reqStr(args, 'session'), reqStr(args, 'config_id'), reqStr(args, 'value'), signal),
    }),
    status: args => manager.status(reqStr(args, 'session')),
    progress: args => manager.progress(reqStr(args, 'session')),
    output: args => manager.output(reqStr(args, 'session')),
    close: args => manager.close(optStr(args, 'session')),
    delete: args => manager.delete(reqStr(args, 'session')),
    snapshot: args => snapshot(manager, store, args),
    item: args => item(manager, store, args),
  }
}

// ── Results ──

/** Structured result plus the same JSON as a text block for clients without structured content. */
function success(value: object): CallToolResult {
  const text = JSON.stringify(value)
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) }
}

function failure(code: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true }
}

/**
 * Build the MCP server for a SessionManager and the ConversationStore listening to it. No transport is
 * attached here, so stdio today and other transports later share the same construction. Handlers only
 * check params and wrap results; the request's abort signal is passed to blocking calls. A blocking call
 * whose request carries a progressToken gets a progress notification every heartbeatMs while it waits,
 * which keeps idle-based client timeouts (Claude Code) from firing during long turns.
 */
export function createServer(manager: SessionManager, store: ConversationStore, version: string, opts: ServerOptions = {}): Server {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`))
  const server = new Server({ name: 'subagent-cockpit-mcp', version }, { capabilities: { tools: {} } })
  const byName = handlers(manager, store)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {}, _meta } = request.params
    const spec = SPEC_BY_NAME.get(name)
    if (!spec) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
    checkArgs(spec, args)
    const token = spec.blocking ? _meta?.progressToken : undefined
    const beat = { progress: 0 }
    const timer = token === undefined ? undefined : setInterval(() => {
      beat.progress += 1
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: beat.progress, message: 'Waiting for the agent' } })
        .catch((err: Error) => log(`progress notification failed: ${err.message}`))
    }, heartbeatMs)
    try {
      return success(await byName[name](args, extra.signal))
    } catch (err) {
      // Argument errors found inside a handler (answerContent) stay JSON-RPC errors
      if (err instanceof McpError) throw err
      if (err instanceof CockpitError) return failure(err.code, err.message)
      return failure('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    } finally {
      clearInterval(timer)
    }
  })
  return server
}
