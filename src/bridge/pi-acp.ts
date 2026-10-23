import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type * as acp from '@agentclientprotocol/sdk'

/**
 * ACP agent over `pi --mode rpc` (Earendil's pi coding agent). One bridge process serves one session, with one
 * long-lived pi under it: prompts, model and thinking level changes and aborts are RPC commands; session events
 * become session/update. pi asks for neither approvals nor questions; extension dialogs are answered as cancelled.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

/** A tool result as pi reports it (tool_execution_update / _end, toolResult messages) */
interface PiToolResult {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Json
  details?: Json
}
interface PiUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number }
/** A message of get_messages, turn_end and agent_end; content is a string or blocks */
interface PiMessage {
  role?: string
  content?: string | PiBlock[]
  stopReason?: string
  errorMessage?: string
  usage?: PiUsage
  toolCallId?: string
  toolName?: string
  isError?: boolean
  details?: Json
}
interface PiBlock { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: JsonObject }

// One stdout record of pi --mode rpc before its kind is checked (docs/rpc.md, rpc-commands.md, json.md)
interface PiLine {
  type?: string
  id?: string
  command?: string
  success?: boolean
  data?: JsonObject
  error?: string
  assistantMessageEvent?: { type?: string; delta?: string }
  toolCallId?: string
  toolName?: string
  args?: JsonObject
  partialResult?: PiToolResult
  result?: PiToolResult
  isError?: boolean
  message?: PiMessage
  aborted?: boolean
  method?: string
}

interface PiResponse { success: boolean; data: JsonObject; error: string }

/** What one prompt gathers from pi's events until agent_settled */
interface TurnState {
  usage?: NonNullable<acp.PromptResponse['usage']>
  last?: PiMessage
}

const STOP_KILL_MS = 2000
const STDERR_KEPT = 2000
const TITLE_LENGTH = 120
const DIALOGS = ['select', 'confirm', 'input', 'editor']
const DIFF_TOOLS = ['edit', 'write']
const TOOL_KINDS: Array<[RegExp, acp.ToolKind]> = [
  [/^bash$/, 'execute'],
  [/^(read|ls)$/, 'read'],
  [/^(edit|write)$/, 'edit'],
  [/^(grep|find)$/, 'search'],
]
const PI = process.env.PI_PATH ?? 'pi'
const USER_ARGS = process.argv.slice(2)

function log(message: string): void {
  process.stderr.write(`[pi-acp] ${message}\n`)
}

const str = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: Json | undefined): number | undefined => (typeof value === 'number' ? value : undefined)
const obj = (value: Json | undefined): JsonObject | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined)
const list = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : [])

/** Parse one stdout line; undefined (and logged) for anything that is not a JSON object. */
function parseLine(line: string): PiLine | undefined {
  try {
    const value: PiLine | null = JSON.parse(line)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch (err) {
    log(`ignored: ${line} (${err instanceof Error ? err.message : err})`)
    return undefined
  }
  log(`ignored: ${line}`)
  return undefined
}

/** A get_messages entry with the fields the replay reads, each checked for its type. */
function toMessage(value: Json): PiMessage {
  const message = obj(value) ?? {}
  const block = (entry: JsonObject): PiBlock => ({
    type: str(entry.type),
    text: str(entry.text),
    thinking: str(entry.thinking),
    id: str(entry.id),
    name: str(entry.name),
    arguments: obj(entry.arguments),
  })
  const content = typeof message.content === 'string' ? message.content : list(message.content).map(obj).flatMap(entry => (entry ? [block(entry)] : []))
  return {
    role: str(message.role),
    content,
    toolCallId: str(message.toolCallId),
    toolName: str(message.toolName),
    isError: message.isError === true,
    details: message.details,
  }
}

const textOf = (result: PiToolResult | undefined): string => (result?.content ?? []).map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')

const textContent = (text: string): acp.ToolCallContent[] => (text ? [{ type: 'content', content: { type: 'text', text } }] : [])

/** The diffs an edit or write call stands for: one per replaced block, or the whole new file. */
function diffsOf(toolName: string, args: JsonObject): acp.ToolCallContent[] {
  const path = str(args.path) ?? ''
  if (toolName === 'write') return [{ type: 'diff', path, oldText: null, newText: str(args.content) ?? '' }]
  if (toolName !== 'edit') return []
  return list(args.edits).map(obj).flatMap(edit => (edit ? [{ type: 'diff', path, oldText: str(edit.oldText) ?? '', newText: str(edit.newText) ?? '' }] : []))
}

/** tool_call for a tool pi starts (or one replayed from history). */
function toolCall(toolCallId: string, toolName: string, args: JsonObject): acp.SessionUpdate {
  const target = Object.values(args).find((v): v is string => typeof v === 'string')
  const path = str(args.path)
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: target ? `${toolName} ${target.slice(0, TITLE_LENGTH)}` : toolName,
    kind: TOOL_KINDS.find(([pattern]) => pattern.test(toolName))?.[1] ?? 'other',
    status: 'in_progress',
    rawInput: args,
    ...(path ? { locations: [{ path }] } : {}),
    content: diffsOf(toolName, args),
  }
}

/** tool_call_update for a finished tool. Edits and writes keep the diffs they started with. */
function toolEnd(toolCallId: string, toolName: string, result: PiToolResult, isError: boolean): acp.SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: isError ? 'failed' : 'completed',
    rawOutput: result.structuredContent ?? result.details ?? (result.content ? textOf(result) : null),
    ...(DIFF_TOOLS.includes(toolName) ? {} : { content: textContent(textOf(result)) }),
  }
}

/** pi's per-response usage added to the turn's, in ACP terms. */
function addUsage(sum: TurnState['usage'], usage: PiUsage): NonNullable<TurnState['usage']> {
  const base = sum ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 }
  return {
    totalTokens: base.totalTokens + (usage.totalTokens ?? 0),
    inputTokens: base.inputTokens + (usage.input ?? 0),
    outputTokens: base.outputTokens + (usage.output ?? 0),
    thoughtTokens: (base.thoughtTokens ?? 0) + (usage.reasoning ?? 0),
    cachedReadTokens: (base.cachedReadTokens ?? 0) + (usage.cacheRead ?? 0),
    cachedWriteTokens: (base.cachedWriteTokens ?? 0) + (usage.cacheWrite ?? 0),
  }
}

/** One running `pi --mode rpc` process: commands with ids, responses by id, session events to one listener. */
class PiProcess {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>
  readonly exited: Promise<number | null>
  private buffer = ''
  private stderrTail = ''
  private seq = 0
  private done = false
  private stopping?: Promise<void>
  private readonly pending = new Map<string, { resolve: (response: PiResponse) => void; reject: (err: Error) => void }>()
  onEvent: (line: PiLine) => void = () => undefined

  constructor(cwd: string, sessionId?: string) {
    this.child = spawn(PI, ['--mode', 'rpc', ...(sessionId ? ['--session', sessionId] : []), ...USER_ARGS], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    // 'close' rather than 'exit': stdout and stderr are read to the end before it fires
    this.exited = new Promise(resolve => {
      this.child.once('close', code => resolve(code))
      this.child.once('error', err => {
        log(`spawn ${PI} failed: ${err.message}`)
        resolve(null)
      })
    })
    this.exited.then(code => {
      this.done = true
      this.pending.forEach(({ reject }) => reject(new Error(`pi exited with code ${code}`)))
      this.pending.clear()
    })
    this.child.stdin.on('error', err => log(`pi stdin error: ${err.message}`))
    this.child.stdout.setEncoding('utf-8')
    this.child.stderr.setEncoding('utf-8')
    this.child.stdout.on('data', (chunk: string) => this.read(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_KEPT)
    })
  }

  /** False once pi has exited or stop() has begun. */
  get alive(): boolean {
    return !this.stopping && !this.done
  }

  get exitCode(): number | null {
    return this.child.exitCode
  }

  get stderr(): string {
    return this.stderrTail
  }

  /** Send one command and wait for its response; rejects when pi exits first. */
  request(command: JsonObject): Promise<PiResponse> {
    if (!this.alive) return Promise.reject(new Error('pi is not running'))
    const id = `b${++this.seq}`
    const response = new Promise<PiResponse>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.write({ id, ...command })
    return response
  }

  /** Close stdin (pi ends a running turn and exits), SIGKILL after STOP_KILL_MS; resolves once pi has exited. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.child.stdin.end()
      const timer = setTimeout(() => this.child.kill('SIGKILL'), STOP_KILL_MS)
      await this.exited
      clearTimeout(timer)
    })()
    return this.stopping
  }

  private write(record: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  /** Split records on LF only: readline would also split inside JSON strings at U+2028 and U+2029. */
  private read(chunk: string): void {
    const parts = `${this.buffer}${chunk}`.split('\n')
    this.buffer = parts.pop() ?? ''
    parts.map(part => part.replace(/\r$/, '')).filter(part => part.trim()).forEach(part => this.dispatch(part))
  }

  private dispatch(line: string): void {
    const record = parseLine(line)
    if (!record) return
    if (record.type === 'response') {
      const waiter = record.id ? this.pending.get(record.id) : undefined
      record.id && this.pending.delete(record.id)
      waiter?.resolve({ success: record.success === true, data: record.data ?? {}, error: record.error ?? '' })
      return
    }
    // A dialog blocks pi until it is answered; nobody here can answer it
    if (record.type === 'extension_ui_request' && DIALOGS.includes(record.method ?? '')) {
      this.write({ type: 'extension_ui_response', id: record.id ?? '', cancelled: true })
      return
    }
    this.onEvent(record)
  }
}

/** ACP agent for a single pi session. */
class PiAgent implements acp.Agent {
  private sessionId = ''
  private cwd = ''
  private pi?: PiProcess
  private configs: acp.SessionConfigOption[] = []
  private cancelling = false
  private running = false
  /** Set by shutdown(); no pi is started after it */
  private closed = false
  /** Numbers assistant messages across the session, so each gets its own messageId */
  private messageSeq = 0

  constructor(private readonly conn: AgentSideConnection) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, delete: {} } }, authMethods: [] }
  }

  async newSession({ cwd }: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.oneSession()
    this.cwd = cwd
    this.sessionId = await this.startPi()
    this.configs = await this.readConfigs()
    this.announceCommands()
    return { sessionId: this.sessionId, configOptions: this.configs }
  }

  async loadSession({ sessionId, cwd }: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    this.oneSession()
    await this.reopen(sessionId, cwd)
    const history = await this.command({ type: 'get_messages' })
    // Chained one by one so the whole replay goes out, in order, before the load response
    await list(history.data.messages).reduce((chain, message) => chain.then(() => this.replay(toMessage(message))), Promise.resolve())
    // Scheduled only once the replay is done, so the commands follow the load response
    this.announceCommands()
    return { configOptions: this.configs }
  }

  async resumeSession({ sessionId, cwd }: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    this.oneSession()
    await this.reopen(sessionId, cwd)
    this.announceCommands()
    return { configOptions: this.configs }
  }

  async setSessionConfigOption({ configId, value }: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const choices = this.configs.find(option => option.id === configId)
    const allowed = choices?.type === 'select' && choices.options.some(choice => 'value' in choice && choice.value === value)
    if (!allowed || typeof value !== 'string') throw RequestError.invalidParams(undefined, `unsupported value for ${configId}: ${value}`)
    const slash = value.indexOf('/')
    const command: JsonObject = configId === 'model'
      ? { type: 'set_model', provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
      : { type: 'set_thinking_level', level: value }
    const response = await this.command(command)
    if (!response.success) throw RequestError.invalidParams(undefined, response.error)
    this.configs = await this.readConfigs()
    return { configOptions: this.configs }
  }

  async prompt({ prompt }: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.cancelling = false
    const text = prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
    if (!this.pi?.alive) {
      // A cancel while pi restarts has no turn to abort: send nothing and keep the new pi for the next turn
      const started = await this.startPi(this.sessionId).then(() => true, (err: Error) => (this.cancelling ? false : Promise.reject(err)))
      if (!started || this.cancelling) return { stopReason: 'cancelled' }
    }
    const pi = this.pi
    if (!pi) throw RequestError.internalError(undefined, 'pi is not running')
    const turn: TurnState = {}
    this.messageSeq += 1
    const settled = new Promise<{ aborted: boolean } | null>(resolve => {
      pi.onEvent = line => (line.type === 'agent_settled' ? resolve({ aborted: line.aborted === true }) : this.forward(line, turn))
      pi.exited.then(() => resolve(null))
    })
    this.running = true
    try {
      const response = await pi.request({ type: 'prompt', message: text }).catch(() => null)
      if (response && !response.success) {
        throw /No API key found/.test(response.error)
          ? RequestError.authRequired(undefined, response.error)
          : RequestError.internalError(undefined, response.error)
      }
      if (str(response?.data.disposition) === 'handled') return { stopReason: 'end_turn' }
      const end = await settled
      if (!end) {
        if (this.cancelling) return { stopReason: 'cancelled' }
        throw RequestError.internalError(undefined, `pi exited with code ${pi.exitCode}`)
      }
      if (end.aborted) return { stopReason: 'cancelled' }
      if (turn.last?.stopReason === 'error') throw RequestError.internalError(undefined, turn.last.errorMessage ?? 'pi reported an error')
      await this.sendContextUsage()
      return { stopReason: turn.last?.stopReason === 'length' ? 'max_tokens' : 'end_turn', ...(turn.usage ? { usage: turn.usage } : {}) }
    } finally {
      this.running = false
      pi.onEvent = () => undefined
    }
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {
    this.cancelling = true
    this.running && this.pi?.request({ type: 'abort' }).catch((err: Error) => log(`abort failed: ${err.message}`))
  }

  /**
   * Delete the pi session file. A bridge with a session deletes only that one. A fresh bridge (the base class
   * attaches with initialize only to delete a closed session) starts pi on the requested id in its own cwd.
   */
  async deleteSession({ sessionId }: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
    if (this.sessionId && sessionId !== this.sessionId) throw RequestError.invalidParams(undefined, `pi-acp serves session ${this.sessionId} only`)
    this.cwd ||= process.cwd()
    this.sessionId = sessionId
    this.pi?.alive || (await this.startPi(sessionId))
    const state = await this.command({ type: 'get_state' })
    const file = str(state.data.sessionFile)
    if (!file) throw RequestError.internalError(undefined, `pi did not report the file of session ${sessionId}`)
    await this.pi?.stop()
    await rm(file, { force: true })
    return {}
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<void> {
    throw RequestError.methodNotFound('authenticate')
  }

  /**
   * Stop pi when the bridge goes away. `closed` is set before the first await: startPi assigns this.pi
   * synchronously after its check, so the process read here is the last one that will ever be started.
   */
  async shutdown(): Promise<void> {
    this.closed = true
    await this.pi?.stop()
  }

  private oneSession(): void {
    if (this.sessionId) throw RequestError.invalidRequest(undefined, 'pi-acp serves one session per process')
  }

  /** load and resume: start pi on the session; an unknown id makes pi exit with `No session found`. */
  private async reopen(sessionId: string, cwd: string): Promise<void> {
    this.cwd = cwd
    this.sessionId = await this.startPi(sessionId)
    this.configs = await this.readConfigs()
  }

  /**
   * Start pi, optionally on an existing session, and return its session id from get_state. Refuses once shutdown()
   * has begun. An exit before the answer is invalidParams when pi says `No session found`, else internalError with
   * the stderr tail.
   */
  private async startPi(sessionId?: string): Promise<string> {
    if (this.closed) throw RequestError.internalError(undefined, 'pi-acp is shutting down')
    const pi = new PiProcess(this.cwd, sessionId)
    this.pi = pi
    const state = await pi.request({ type: 'get_state' }).catch(async () => {
      await pi.exited
      if (sessionId && /No session found/.test(pi.stderr)) throw RequestError.invalidParams(undefined, `session ${sessionId} not found`)
      throw RequestError.internalError(undefined, `pi exited before it was ready (code ${pi.exitCode}): ${pi.stderr.trim()}`)
    })
    const id = str(state.data.sessionId)
    if (!state.success || !id) {
      await pi.stop()
      throw RequestError.internalError(undefined, state.error || 'pi reported no session id')
    }
    return id
  }

  /** A command to the current pi, which must be running. */
  private async command(command: JsonObject): Promise<PiResponse> {
    const pi = this.pi
    if (!pi?.alive) throw RequestError.internalError(undefined, 'pi is not running')
    return pi.request(command).catch((err: Error) => {
      throw RequestError.internalError(undefined, err.message)
    })
  }

  /** model and reasoning_effort as ACP select options, from pi's state, models and thinking levels. */
  private async readConfigs(): Promise<acp.SessionConfigOption[]> {
    const [state, models, levels] = await Promise.all([
      this.command({ type: 'get_state' }),
      this.command({ type: 'get_available_models' }),
      this.command({ type: 'get_available_thinking_levels' }),
    ])
    const valueOf = (model: JsonObject | undefined) => `${str(model?.provider) ?? 'unknown'}/${str(model?.id) ?? 'unknown'}`
    const current = obj(state.data.model)
    const available = list(models.data.models).map(obj).flatMap(model => (model ? [{ value: valueOf(model), name: str(model.name) ?? valueOf(model) }] : []))
    const modelOptions = available.some(option => option.value === valueOf(current))
      ? available
      : [{ value: valueOf(current), name: str(current?.name) ?? valueOf(current) }, ...available]
    const thinking = str(state.data.thinkingLevel) ?? 'off'
    const levelValues = list(levels.data.levels).flatMap(level => (typeof level === 'string' ? [level] : []))
    return [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: valueOf(current), options: modelOptions },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: thinking,
        options: (levelValues.includes(thinking) ? levelValues : [thinking, ...levelValues]).map(value => ({ value, name: value })),
      },
    ]
  }

  /** After the current response is sent: available_commands_update from get_commands; failures logged. */
  private announceCommands(): void {
    setImmediate(() => {
      this.command({ type: 'get_commands' })
        .then(response => this.send({
          sessionUpdate: 'available_commands_update',
          // pi may leave out the description of an extension command; ACP needs a string
          availableCommands: list(response.data.commands).map(obj).flatMap(command => (command ? [{ name: str(command.name) ?? '', description: str(command.description) ?? '' }] : [])),
        }))
        .catch((err: Error) => log(`get_commands failed: ${err.message}`))
    })
  }

  /** usage_update from get_session_stats, only when pi reports both the context tokens and the window as numbers. */
  private async sendContextUsage(): Promise<void> {
    const stats = await this.command({ type: 'get_session_stats' }).catch((err: Error) => {
      log(`get_session_stats failed: ${err.message}`)
      return undefined
    })
    if (stats && !stats.success) log(`get_session_stats failed: ${stats.error}`)
    const context = obj(stats?.success ? stats.data.contextUsage : undefined)
    const used = num(context?.tokens)
    const size = num(context?.contextWindow)
    if (used === undefined || size === undefined) return
    const cost = num(stats?.data.cost) ?? 0
    await this.send({ sessionUpdate: 'usage_update', used, size, cost: cost > 0 ? { amount: cost, currency: 'USD' } : null })
  }

  /** Map one live pi event to session/update and keep what the turn result needs. */
  private forward(line: PiLine, turn: TurnState): void {
    const { type, assistantMessageEvent: event, toolCallId = '', toolName = '' } = line
    if (type === 'turn_start') this.messageSeq += 1
    if (type === 'turn_end' && line.message) {
      turn.last = line.message
      turn.usage = line.message.usage ? addUsage(turn.usage, line.message.usage) : turn.usage
    }
    const update = this.toUpdate(line, event, toolCallId, toolName)
    update && this.send(update)
  }

  private toUpdate(line: PiLine, event: PiLine['assistantMessageEvent'], toolCallId: string, toolName: string): acp.SessionUpdate | undefined {
    const messageId = `pi-${this.messageSeq}`
    if (line.type === 'message_update' && event?.type === 'text_delta' && event.delta) {
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.delta }, messageId }
    }
    if (line.type === 'message_update' && event?.type === 'thinking_delta' && event.delta) {
      return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.delta }, messageId }
    }
    if (line.type === 'tool_execution_start') return toolCall(toolCallId, toolName, line.args ?? {})
    if (line.type === 'tool_execution_update' && !DIFF_TOOLS.includes(toolName)) {
      return { sessionUpdate: 'tool_call_update', toolCallId, content: textContent(textOf(line.partialResult)) }
    }
    if (line.type === 'tool_execution_end') return toolEnd(toolCallId, toolName, line.result ?? {}, line.isError === true)
    return undefined
  }

  /** One message of get_messages as the session/update it stood for (live events and replay share the converters). */
  private async replay(message: PiMessage): Promise<void> {
    const blocks: PiBlock[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []
    if (message.role === 'user') {
      const text = blocks.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
      text && await this.send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
      return
    }
    if (message.role === 'toolResult') {
      const result: PiToolResult = { content: blocks.map(block => ({ type: block.type ?? 'text', text: block.text })), details: message.details }
      await this.send(toolEnd(message.toolCallId ?? '', message.toolName ?? '', result, message.isError === true))
      return
    }
    if (message.role !== 'assistant') return
    this.messageSeq += 1
    const messageId = `pi-${this.messageSeq}`
    const updates = blocks.flatMap((block): acp.SessionUpdate[] => {
      if (block.type === 'thinking' && block.thinking) return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking }, messageId }]
      if (block.type === 'text' && block.text) return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text }, messageId }]
      if (block.type === 'toolCall') return [toolCall(block.id ?? '', block.name ?? '', block.arguments ?? {})]
      return []
    })
    await updates.reduce((chain, update) => chain.then(() => this.send(update)), Promise.resolve())
  }

  private send(update: acp.SessionUpdate): Promise<void> {
    return this.conn.sessionUpdate({ sessionId: this.sessionId, update })
      .catch((err: Error) => log(`session/update failed: ${err.message}`))
  }
}

const agents: PiAgent[] = []
// Readable.toWeb is typed as ReadableStream<any>, so wrap stdin by hand (as NodeHost.spawn does for agents)
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.once('end', () => controller.close())
  },
})
const conn = new AgentSideConnection(c => {
  const agent = new PiAgent(c)
  agents.push(agent)
  return agent
}, ndJsonStream(Writable.toWeb(process.stdout), input))

// EOF on stdin and SIGTERM share one cleanup. The SIGTERM listener also keeps Node from exiting
// before pi is gone; the parent's SIGKILL comes later than STOP_KILL_MS.
let closing: Promise<void> | undefined
function shutdown(): Promise<void> {
  closing ??= Promise.all(agents.map(a => a.shutdown())).then(() => process.exit(0))
  return closing
}
conn.closed.then(shutdown)
process.on('SIGTERM', shutdown)
