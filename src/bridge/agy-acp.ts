import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type * as acp from '@agentclientprotocol/sdk'

/**
 * ACP agent over `agy -p` (Google Antigravity CLI) in stream-json mode. One bridge process serves one session.
 * agy itself runs one conversation per process: a turn whose settings changed, or that follows a cancel or a crash,
 * restarts agy with --conversation. agy's headless mode has no approvals or questions, so neither is bridged.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// One output line of `agy -p --output-format stream-json`
interface AgyStep {
  step_index: number
  state: 'ACTIVE' | 'DONE' | 'ERROR'
  step_type: string
  text_delta?: string
  tool_name?: string
  tool_info?: { parameters?: Record<string, JsonValue>; output?: JsonValue; error?: { message: string } }
}
interface AgyResult {
  conversation_id: string
  status: 'SUCCESS' | 'ERROR'
  response: string
  error?: string
  denied_actions?: Array<{ action: string; display_name: string }>
  usage?: AgyUsage
}
/** agy's token counts for a turn; input_tokens include the cache reads */
interface AgyUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}
type AgyEvent =
  | { event: 'init'; conversation_id: string; init: { model?: string } }
  | { event: 'step_update'; step_update: AgyStep }
  | { event: 'result'; result: AgyResult }

// A parsed line before its shape is checked
interface AgyLine {
  event?: string
  conversation_id?: string
  init?: { model?: string }
  step_update?: AgyStep
  result?: AgyResult
}

interface Settings { model: string; reasoning_effort: string; mode: string }

const SETTING_KEYS: Array<keyof Settings> = ['model', 'reasoning_effort', 'mode']
const SETTING_INFO: Record<keyof Settings, { name: string; category: acp.SessionConfigOptionCategory }> = {
  model: { name: 'Model', category: 'model' },
  reasoning_effort: { name: 'Reasoning effort', category: 'thought_level' },
  mode: { name: 'Mode', category: 'mode' },
}
const STOP_KILL_MS = 2000
const EFFORTS = /-(low|medium|high|xhigh|max)$/
const MODES = ['default', 'accept-edits', 'plan', 'auto']
const TOOL_KINDS: Array<[RegExp, acp.ToolKind]> = [
  [/^(run_command|send_command_input|command_status)$/, 'execute'],
  [/^(read_file|view_file|list_dir|read_resource)$/, 'read'],
  [/^(write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$/, 'edit'],
  [/^(grep_search|find_by_name|search_web)$/, 'search'],
  [/^(read_url_content|open_browser_url|browser_.+)$/, 'fetch'],
]
const AGY = process.env.AGY_PATH ?? 'agy'
const USER_ARGS = process.argv.slice(2)

function log(message: string): void {
  process.stderr.write(`[agy-acp] ${message}\n`)
}

/** Parse one stdout line; undefined for anything that is not a known agy event (logged to stderr). */
function parseEvent(line: string): AgyEvent | undefined {
  if (!line.trim()) return undefined
  try {
    const value: AgyLine = JSON.parse(line) ?? {}
    const { event, conversation_id, init, step_update, result } = value
    if (event === 'init' && init && conversation_id) return { event, conversation_id, init }
    if (event === 'step_update' && step_update) return { event, step_update }
    if (event === 'result' && result) return { event, result }
  } catch (err) {
    log(`ignored: ${line} (${err instanceof Error ? err.message : err})`)
    return undefined
  }
  log(`ignored: ${line}`)
  return undefined
}

/** agy command line for the given settings, optionally continuing a conversation. */
function agyArgs(settings: Settings, conversationId?: string): string[] {
  const flag = (name: string, value: string) => (value === 'default' ? [] : [`--${name}`, value])
  return [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    ...flag('model', settings.model), ...flag('effort', settings.reasoning_effort), ...flag('mode', settings.mode),
    ...(conversationId ? ['--conversation', conversationId] : []),
    ...USER_ARGS, '-p=',
  ]
}

/** Base model id -> efforts offered for it, from `agy models` (id<TAB>name lines). Empty on failure. */
async function listModels(cwd: string): Promise<Map<string, string[]>> {
  const child = spawn(AGY, ['models'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
  const code = await new Promise<number | null>(resolve => {
    child.once('close', resolve)
    child.once('error', e => {
      log(`agy models failed: ${e.message}`)
      resolve(null)
    })
  })
  if (code !== 0) {
    log(`agy models failed with code ${code}: ${Buffer.concat(err).toString('utf-8').trim()}`)
    return new Map()
  }
  const ids = Buffer.concat(out).toString('utf-8').split('\n')
    .map(line => /^(\S+)\t/.exec(line)?.[1])
    .filter((id): id is string => Boolean(id))
  return ids.reduce((models, id) => {
    const effort = EFFORTS.exec(id)?.[1]
    const base = id.replace(EFFORTS, '')
    return models.set(base, [...(models.get(base) ?? []), ...(effort ? [effort] : [])])
  }, new Map<string, string[]>())
}

/** A turn's usage in ACP terms, where the input leaves out the cache reads that agy counts in it. */
function toUsage({ input_tokens = 0, output_tokens = 0, thinking_tokens, cache_read_tokens = 0, total_tokens }: AgyUsage): NonNullable<acp.PromptResponse['usage']> {
  return {
    totalTokens: total_tokens ?? input_tokens + output_tokens,
    inputTokens: input_tokens - cache_read_tokens,
    outputTokens: output_tokens,
    thoughtTokens: thinking_tokens,
    cachedReadTokens: cache_read_tokens,
  }
}

/** One running `agy -p` process. */
class AgyProcess {
  /** Settings agy was started with; a later change needs a new process */
  readonly settings: Settings
  private readonly child: ChildProcessByStdio<Writable, Readable, null>
  private readonly exited: Promise<number | null>
  private readonly started: Promise<string>
  private done = false
  private running = false
  private stopping?: Promise<void>
  private onInit: (event: AgyEvent) => void = () => undefined
  private onStep: (step: AgyStep) => void = () => undefined
  private onResult: (result: AgyResult) => void = () => undefined

  constructor(cwd: string, settings: Settings, conversationId?: string) {
    this.settings = { ...settings }
    this.child = spawn(AGY, agyArgs(settings, conversationId), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] })
    // 'close' rather than 'exit': the last stdout lines (the result) are read before it fires
    this.exited = new Promise(resolve => {
      this.child.once('close', code => resolve(code))
      this.child.once('error', err => {
        log(`spawn ${AGY} failed: ${err.message}`)
        resolve(null)
      })
    })
    this.exited.then(() => { this.done = true })
    this.child.stdin.on('error', err => log(`agy stdin error: ${err.message}`))
    this.started = new Promise((resolve, reject) => {
      this.onInit = event => {
        if (event.event === 'init') resolve(event.conversation_id)
        if (event.event !== 'result') return
        const message = event.result.error ?? 'agy failed before init'
        reject(/authentication/i.test(message) ? RequestError.authRequired(undefined, message) : RequestError.internalError(undefined, message))
      }
      this.exited.then(code => reject(RequestError.internalError(undefined, `agy exited with code ${code} before init`)))
    })
    createInterface({ input: this.child.stdout }).on('line', line => this.dispatch(parseEvent(line)))
  }

  /** False once agy has exited or stop() has begun; such a process takes no more turns. */
  get alive(): boolean {
    return !this.stopping && !this.done
  }

  get exitCode(): number | null {
    return this.child.exitCode
  }

  /**
   * Conversation id from `init`. Rejects with authRequired when a `result` mentioning authentication comes first,
   * with internalError for any other early `result` or an exit before `init`.
   */
  ready(): Promise<string> {
    return this.started
  }

  /** Send one user turn. Steps go to `onStep`; resolves with the turn's result, or null when agy exits first. */
  turn(text: string, onStep: (step: AgyStep) => void): Promise<AgyResult | null> {
    this.onStep = onStep
    this.running = true
    const result = new Promise<AgyResult | null>(resolve => {
      this.onResult = resolve
      this.exited.then(() => resolve(null))
    }).finally(() => { this.running = false })
    this.child.stdin.write(`${JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`)
    return result
  }

  /** SIGINT the running turn. A no-op between turns, so a cancel while agy starts leaves it running. */
  interrupt(): void {
    this.running && this.child.kill('SIGINT')
  }

  /**
   * Close stdin, SIGINT a running turn at once and SIGKILL after STOP_KILL_MS; resolves once agy has exited.
   * Idempotent. Stays inside the parent's 1s SIGTERM / 4s SIGKILL window for the bridge (SubagentAdapter.terminate).
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.child.stdin.end()
      this.interrupt()
      const timer = setTimeout(() => this.child.kill('SIGKILL'), STOP_KILL_MS)
      await this.exited
      clearTimeout(timer)
    })()
    return this.stopping
  }

  private dispatch(event: AgyEvent | undefined): void {
    if (event?.event === 'step_update') this.onStep(event.step_update)
    if (event?.event === 'init') this.onInit(event)
    if (event?.event !== 'result') return
    // A result before init settles ready(); later ones end the running turn
    this.onInit(event)
    this.onInit = () => undefined
    this.onResult(event.result)
  }
}

/** ACP agent for a single agy conversation. */
class AgyAgent implements acp.Agent {
  private sessionId = ''
  private cwd = ''
  private settings: Settings = { model: 'default', reasoning_effort: 'default', mode: 'default' }
  private models = new Map<string, string[]>()
  private agy?: AgyProcess
  private cancelling = false
  /** Set by shutdown(); no agy is started after it */
  private closed = false

  constructor(private readonly conn: AgentSideConnection) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] }
  }

  async newSession({ cwd }: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    if (this.sessionId) throw RequestError.invalidRequest(undefined, 'agy-acp serves one session per process')
    this.cwd = cwd
    const [models, sessionId] = await Promise.all([listModels(cwd), this.startAgy()])
    this.models = models
    this.sessionId = sessionId
    return { sessionId, configOptions: this.configOptions() }
  }

  async resumeSession({ sessionId, cwd }: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    if (this.sessionId) throw RequestError.invalidRequest(undefined, 'agy-acp serves one session per process')
    this.cwd = cwd
    const [models] = await Promise.all([listModels(cwd), this.startAgy(sessionId)])
    this.models = models
    this.sessionId = sessionId
    return { configOptions: this.configOptions() }
  }

  async setSessionConfigOption({ configId, value }: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const key = SETTING_KEYS.find(k => k === configId)
    if (!key || typeof value !== 'string' || !this.choices()[key].includes(value)) {
      throw RequestError.invalidParams(undefined, `unsupported value for ${configId}: ${value}`)
    }
    this.settings = { ...this.settings, [key]: value }
    // A model that does not offer the current effort falls back to agy's default effort
    if (key === 'model' && !this.choices().reasoning_effort.includes(this.settings.reasoning_effort)) {
      this.settings = { ...this.settings, reasoning_effort: 'default' }
    }
    return { configOptions: this.configOptions() }
  }

  async prompt({ prompt }: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.cancelling = false
    const text = prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
    const stale = !this.agy?.alive || SETTING_KEYS.some(key => this.agy?.settings[key] !== this.settings[key])
    if (stale) {
      await this.agy?.stop()
      try {
        await this.startAgy(this.sessionId)
      } catch (err) {
        if (this.cancelling) return { stopReason: 'cancelled' }
        throw err
      }
      if (this.closed) throw RequestError.internalError(undefined, 'agy-acp is shutting down')
      if (this.cancelling) return { stopReason: 'cancelled' }
    }
    const agy = this.agy
    if (!agy) throw RequestError.internalError(undefined, 'agy is not running')
    const result = await agy.turn(text, step => this.forward(step))
    if (this.cancelling) {
      // agy exits after an interrupt; never hand it the next turn
      await agy.stop()
      if (result?.status !== 'SUCCESS') return { stopReason: 'cancelled' }
    }
    if (!result) throw RequestError.internalError(undefined, `agy exited with code ${agy.exitCode}`)
    if (result.status === 'ERROR') throw RequestError.internalError(undefined, result.error ?? 'agy reported an error')
    const denied = result.denied_actions ?? []
    if (denied.length > 0) {
      const names = denied.map(d => d.display_name).join(', ')
      const note = `agy denied in headless mode: ${names}. Allow them in agy settings.json (permissions.allow) or pass --dangerously-skip-permissions in args.`
      await this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: note }, messageId: 'agy-denied' },
      })
    }
    return { stopReason: 'end_turn', ...(result.usage ? { usage: toUsage(result.usage) } : {}) }
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {
    this.cancelling = true
    this.agy?.interrupt()
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<void> {
    throw RequestError.methodNotFound('authenticate')
  }

  /**
   * Stop agy when the bridge goes away. `closed` is set before the first await: startAgy assigns this.agy
   * synchronously after its check, so the process read here is the last one that will ever be started.
   */
  async shutdown(): Promise<void> {
    this.closed = true
    await this.agy?.stop()
  }

  /**
   * Start agy and wait for its conversation id. A continued conversation must come back with the same id:
   * agy silently starts a new one for an unknown id. On any failure the new process is stopped.
   * Refuses once shutdown() has begun, so a prompt that was waiting for the old agy to stop spawns nothing.
   */
  private async startAgy(conversationId?: string): Promise<string> {
    if (this.closed) throw RequestError.internalError(undefined, 'agy-acp is shutting down')
    const agy = new AgyProcess(this.cwd, this.settings, conversationId)
    this.agy = agy
    const started = await agy.ready().catch(async (err: Error) => {
      await agy.stop()
      throw err
    })
    if (conversationId && started !== conversationId) {
      await agy.stop()
      throw RequestError.invalidParams(undefined, `conversation ${conversationId} not found`)
    }
    return started
  }

  /** Map one agy step to session/update, as in the event table of plan section 4.4.5. */
  private forward(step: AgyStep): void {
    const update = this.toUpdate(step)
    update && this.conn.sessionUpdate({ sessionId: this.sessionId, update })
      .catch((err: Error) => log(`session/update failed: ${err.message}`))
  }

  private toUpdate({ step_index, state, step_type, text_delta, tool_name, tool_info }: AgyStep): acp.SessionUpdate | undefined {
    if (step_type === 'agent_response' && text_delta) {
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text_delta }, messageId: String(step_index) }
    }
    if (step_type !== 'tool') return undefined
    const toolCallId = `step-${step_index}`
    if (state === 'DONE') return { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { output: tool_info?.output ?? null } }
    if (state === 'ERROR') {
      const text = tool_info?.error?.message ?? 'tool failed'
      return { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text } }] }
    }
    const name = tool_name ?? 'tool'
    const target = Object.values(tool_info?.parameters ?? {}).find((v): v is string => typeof v === 'string')
    return {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: target ? `${name} ${target.slice(0, 120)}` : name,
      kind: TOOL_KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'other',
      status: 'in_progress',
      rawInput: tool_info?.parameters ?? {},
    }
  }

  /** Values each setting accepts: efforts depend on the current model, 'default' leaves the choice to agy. */
  private choices(): Record<keyof Settings, string[]> {
    return {
      model: ['default', ...this.models.keys()],
      reasoning_effort: ['default', ...(this.models.get(this.settings.model) ?? [])],
      mode: MODES,
    }
  }

  /** model, reasoning_effort and mode as ACP select options, current values from this.settings. */
  private configOptions(): acp.SessionConfigOption[] {
    const choices = this.choices()
    return SETTING_KEYS.map((key): acp.SessionConfigOption => ({
      id: key,
      ...SETTING_INFO[key],
      type: 'select',
      currentValue: this.settings[key],
      options: choices[key].map(value => ({ value, name: value })),
    }))
  }
}

const agents: AgyAgent[] = []
// Readable.toWeb is typed as ReadableStream<any>, so wrap stdin by hand (as NodeHost.spawn does for agents)
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.once('end', () => controller.close())
  },
})
const conn = new AgentSideConnection(c => {
  const agent = new AgyAgent(c)
  agents.push(agent)
  return agent
}, ndJsonStream(Writable.toWeb(process.stdout), input))

// EOF on stdin and SIGTERM share one cleanup. The SIGTERM listener also keeps Node from exiting
// before agy is gone; the parent's SIGKILL comes later than STOP_KILL_MS.
let closing: Promise<void> | undefined
function shutdown(): Promise<void> {
  closing ??= Promise.all(agents.map(a => a.shutdown())).then(() => process.exit(0))
  return closing
}
conn.closed.then(shutdown)
process.on('SIGTERM', shutdown)
