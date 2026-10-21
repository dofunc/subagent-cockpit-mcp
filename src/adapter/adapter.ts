import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type * as acp from '@agentclientprotocol/sdk'
import type { ChildProcess, Host } from '../host/host'
import type {
  AgentState, AnswerAction, AnswerContent, ApprovalInfo, ApprovalResolution, CommandInfo, ConfigOptionInfo, ErrorCode,
  ConversationActivity, NativeDeleteResult, NotificationItem, PermissionOptionInfo, PermissionOptionKind, PlanEntryInfo,
  PromptResult, QuestionInfo, SessionEvent, SessionView, SubagentConfig, ToolCallView, TurnOutcome, UsageInfo,
} from '../types'

// ── Errors ──

export class CockpitError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'CockpitError'
  }
}

// ── Adapter Registry ──

export type AdapterCtor = new (host: Host) => SubagentAdapter

const registry = new Map<string, AdapterCtor>()

export function registerAdapter(name: string, ctor: AdapterCtor): void {
  registry.set(name, ctor)
}

export function createAdapter(name: string, host: Host): SubagentAdapter {
  const Ctor = registry.get(name)
  if (!Ctor) throw new CockpitError('SUBAGENT_NOT_FOUND', `Unknown adapter: ${name}`)
  return new Ctor(host)
}

// ── Process-wide counters ──

// Turn, approval and question ids and event seqs never repeat within one MCP server process,
// across sessions and across reconnects of the same session.
const counters = { turn: 0, approval: 0, question: 0, seq: 0 }

/** Latest event seq issued in this process. */
export function currentSeq(): number {
  return counters.seq
}

const EVENT_LIMIT = 500
const ESTABLISH_LIMIT_MS = 30_000
const VERSION_LIMIT_MS = 10_000
const CANCEL_CONFIRM_MS = 10_000
const EOF_GRACE_MS = 1_000
const KILL_GRACE_MS = 3_000
const AUTH_REQUIRED_CODE = -32000

// ── Adapter ──

export interface CommandSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

/** What a vendor adapter tells the base class about its agent. */
export interface AgentSpec {
  /** Program looked up in PATH when the subagent path is empty, e.g. 'codex' */
  program: string
  /** Lowest program version known to work, e.g. [0, 160, 1] */
  min_version: number[]
  /** Env var through which the bundled ACP adapter receives the program's absolute path. Absent when the program speaks ACP itself */
  path_env?: string
  /** Bundled ACP adapter next to dist/cli.js, e.g. 'codex-acp.js'. Absent when the program speaks ACP itself */
  entry?: string
}

/** `_meta` carried by session/new, session/load and session/resume. */
export type SessionMeta = acp.NewSessionRequest['_meta']

/** A native session to act on. */
export interface NativeSession {
  nativeId: string
  cwd: string
  config: SubagentConfig
  /** A new, unstarted adapter of the same kind, for operations that need a temporary agent */
  temporary: () => SubagentAdapter
}

/** Native session operations of one agent kind. The adapters involved end up closed, also on failure. */
export interface NativeSessionManager {
  delete(session: NativeSession): Promise<NativeDeleteResult>
}

export interface OpenOptions {
  config: SubagentConfig
  cwd: string
  role: string
  /** Native session id to reconnect to. Omit to create a new session. */
  resumeId?: string
  signal?: AbortSignal
  /** Runs right after the native session exists, before setup continues. Throwing aborts the open. */
  onEstablished: (nativeId: string) => Promise<void>
}

export interface WaitOptions {
  /** Absolute time (clock ms) when the wait gives up. Omitted = no limit. */
  deadline?: number
  signal?: AbortSignal
}

export type ApprovalVerb = 'approve' | 'allow' | 'reject'

/** Activity as the adapter sees it; the session layer adds the session id and lifecycle events. */
export type AdapterActivity =
  | Exclude<ConversationActivity, { kind: 'acp' | 'session_opened' | 'session_closed' }>
  | { kind: 'acp'; direction: 'in' | 'out'; message: acp.AnyMessage }

interface PendingApproval {
  info: ApprovalInfo
  request: acp.RequestPermissionRequest
  respond: (outcome: acp.RequestPermissionOutcome) => void
}

interface PendingQuestion {
  info: QuestionInfo
  respond: (response: acp.CreateElicitationResponse) => void
}

/** A session-scoped "don't ask again" rule kept by the adapter after `allow`. */
export interface AllowRule {
  matches(request: acp.RequestPermissionRequest): boolean
}

interface Turn {
  turn_id: number
  internal: boolean
  output: string
  tool_calls: Map<string, ToolCallView>
  /** messageId of the last message chunk, when the agent sends one. */
  message_id: string | null
  /** A tool call arrived since the last message chunk. */
  tool_since_message: boolean
}

interface TurnRecord {
  turn_id: number
  internal: boolean
  outcome: TurnOutcome
  output: string
  error?: CockpitError
}

interface Notice {
  item: Omit<NotificationItem, 'key'>
  delivered: boolean
}

const VERB_KINDS: Record<ApprovalVerb, PermissionOptionKind> = {
  approve: 'allow_once',
  allow: 'allow_once',
  reject: 'reject_once',
}

function toConfigInfo(option: acp.SessionConfigOption): ConfigOptionInfo {
  const base = { id: option.id, name: option.name, category: option.category ?? null }
  if (option.type === 'boolean') return { ...base, type: 'boolean', current_value: option.currentValue, options: [] }
  const flat = option.options.flatMap((o: acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup) => 'group' in o ? o.options : [o])
  return { ...base, type: 'select', current_value: option.currentValue, options: flat.map(o => ({ value: o.value, name: o.name })) }
}

function textOf(content: acp.ContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/** The `command` string of a tool call's raw input, when it has one. */
export function commandOf(toolCall: acp.ToolCallUpdate): string | undefined {
  const raw = toolCall.rawInput
  return raw && typeof raw === 'object' && 'command' in raw && typeof raw.command === 'string' ? raw.command : undefined
}

function versionAtLeast(version: number[], min: number[]): boolean {
  const diff = version.map((v, i) => v - min[i]).find(d => d !== 0)
  return (diff ?? 0) >= 0
}

/**
 * Append a message chunk to the turn's reply. A new messageId, or a tool call since the previous
 * chunk, starts a new message, separated from the previous one by a blank line.
 */
function appendMessage(turn: Turn, text: string, messageId: string | null): void {
  const newMessage = turn.tool_since_message || (messageId !== null && turn.message_id !== null && messageId !== turn.message_id)
  turn.output += turn.output && newMessage ? `\n\n${text}` : text
  turn.message_id = messageId ?? turn.message_id
  turn.tool_since_message = false
}

/**
 * SubagentAdapter — base class driving one agent process over ACP.
 *
 * ACP requests run in the background; their completion callbacks drive the state machine
 * and record notifications. Blocking calls only observe state through waiters, so a result
 * is handed back as soon as it exists rather than when the whole turn finishes.
 * The base class also finds and version-checks the local agent program and launches the bundled
 * ACP adapter, or the program itself when it speaks ACP. Subclasses provide `spec` and may override
 * the other protected hooks.
 */
export abstract class SubagentAdapter {
  protected child?: ChildProcess
  protected conn?: ClientSideConnection
  protected capabilities: acp.AgentCapabilities = {}
  private stateValue: AgentState = 'OPENING'
  private cancellingValue = false
  private nativeIdValue = ''
  private configOptions: acp.SessionConfigOption[] = []
  private readonly events: SessionEvent[] = []
  private droppedSeq = 0
  private loading = false
  private bootstrapping = false
  private expectingExit = false
  private currentTurn?: Turn
  private lastTurn?: TurnRecord
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly allowRules: AllowRule[] = []
  private readonly handledApprovals = new Set<string>()
  private readonly questions = new Map<string, PendingQuestion>()
  private readonly handledQuestions = new Set<string>()
  private readonly feedback: { plan: PlanEntryInfo[]; usage: UsageInfo | null; title: string | null; commands: CommandInfo[] } =
    { plan: [], usage: null, title: null, commands: [] }
  private readonly titleListeners = new Set<(title: string | null) => void>()
  // Set by the first session_info_update that carries title, null included. Until then the title is unknown, not cleared.
  private titleReceived = false
  private readonly notices = new Map<string, Notice>()
  private readonly listeners = new Set<() => void>()
  private readonly exitListeners = new Set<() => void>()
  private readonly activityListeners = new Set<(activity: AdapterActivity) => void>()
  // `${state}:${cancelling}` last reported to the activity listeners
  private lastActivityState = ''
  private waiters = 0
  private idleSinceValue = 0
  private cancelSent: Promise<void> = Promise.resolve()

  constructor(protected readonly host: Host) {}

  // ── Subclass interface ──

  protected abstract readonly spec: AgentSpec

  /**
   * Launch command. With spec.entry: the bundled ACP adapter on the current Node, env already carrying
   * spec.path_env. Without: `program` itself, the located absolute path of the local program.
   */
  protected getCommand(_config: SubagentConfig, env: Record<string, string>, program: string): CommandSpec {
    const { entry } = this.spec
    return entry
      ? { command: this.host.env.execPath(), args: [this.host.bundledPath(entry)], env }
      : { command: program, args: [], env }
  }

  /** Config applied to new sessions before the role prompt, in order. Empty values are skipped. */
  protected initialConfig(config: SubagentConfig): Array<[string, string]> {
    return [['model', config.model], ['reasoning_effort', config.reasoning_effort]]
  }

  /** `_meta` sent with session/new, session/load and session/resume. Default: args are not supported and ignored. */
  protected argsMeta(args: string[]): SessionMeta {
    args.length > 0 && this.host.log(`${this.spec.program} adapter ignores args; use env instead`)
    return undefined
  }

  /** Host env merged with config env. An empty string deletes the variable. */
  protected buildEnv(config: SubagentConfig): Record<string, string> {
    const merged = { ...this.host.env.all(), ...config.env }
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ''))
  }

  /** Pick the option for approve / reject by ACP option kind. */
  protected pickOption(verb: 'approve' | 'reject', options: PermissionOptionInfo[]): PermissionOptionInfo | undefined {
    return options.find(o => o.kind === VERB_KINDS[verb])
  }

  /**
   * The agent's own option that allows only for this session. ACP kinds cannot tell a session
   * scope from a persistent one (both are allow_always), so the base class finds none and allow
   * falls back to an adapter-kept rule. Agents with known session-scoped option ids override it.
   */
  protected sessionAllowOption(_options: PermissionOptionInfo[]): PermissionOptionInfo | undefined {
    return undefined
  }

  /**
   * Rule kept after allow. Shell commands match on the exact command: the raw input of Claude and Grok
   * also carries a per-call description, so the whole raw input never matches twice. Other requests
   * match on tool kind, title, raw input and locations.
   */
  protected allowRule(request: acp.RequestPermissionRequest): AllowRule {
    const command = commandOf(request.toolCall)
    if (request.toolCall.kind === 'execute' && command) {
      return { matches: ({ toolCall }) => toolCall.kind === 'execute' && commandOf(toolCall) === command }
    }
    const key = ({ toolCall }: acp.RequestPermissionRequest) => JSON.stringify([
      toolCall.kind ?? null,
      toolCall.title ?? null,
      toolCall.rawInput ?? null,
      toolCall.locations?.map(l => l.path) ?? null,
    ])
    const expected = key(request)
    return { matches: r => key(r) === expected }
  }

  /** Map an auth_required error. Must not call ACP authenticate — users log in themselves. */
  protected onAuthRequired(error: RequestError): CockpitError {
    return new CockpitError('AUTH_REQUIRED', `Agent requires authentication: ${error.message}. Log in with the agent CLI or check the subagent env config.`)
  }

  protected buildInitPrompt(role: string): string {
    const header = `[subagent-cockpit] ${role || 'hi'}`
    const notice = '[SYSTEM] Above is your session role, not a task message. Do not act on the role itself — do not call tools, write, edit, run, or analyze yet. Reply "OK" to acknowledge and wait for the user\'s actual task.'
    return `${header}\n\n${notice}`
  }

  /** Result of a successful native delete. Agents that archive instead of deleting override it. */
  protected nativeDeleteResult(): NativeDeleteResult {
    return 'deleted'
  }

  // ── Accessors ──

  get state(): AgentState { return this.stateValue }
  get cancelling(): boolean { return this.cancellingValue }
  get nativeId(): string { return this.nativeIdValue }
  get waiting(): boolean { return this.waiters > 0 }
  /** Clock time of the last transition to IDLE. */
  get idleSince(): number { return this.idleSinceValue }
  get busy(): boolean {
    return this.bootstrapping || this.stateValue === 'RUNNING' || this.stateValue === 'ASKING' || this.stateValue === 'QUESTIONING'
  }
  /** An agent process was started by this adapter (it may have been closed since). */
  protected get started(): boolean { return this.child !== undefined }
  get configs(): ConfigOptionInfo[] { return this.configOptions.map(toConfigInfo) }
  get pendingApprovals(): ApprovalInfo[] { return [...this.approvals.values()].map(p => p.info) }
  get pendingQuestions(): QuestionInfo[] { return [...this.questions.values()].map(q => q.info) }
  get plan(): PlanEntryInfo[] { return this.feedback.plan }
  get usage(): UsageInfo | null { return this.feedback.usage }
  get title(): string | null { return this.feedback.title }
  get commands(): CommandInfo[] { return this.feedback.commands }
  get lastOutput(): { turn_id: number | null; output: string } {
    return { turn_id: this.lastTurn?.turn_id ?? null, output: this.lastTurn?.output ?? '' }
  }

  /** Called once when the agent process exits without close(). */
  onUnexpectedExit(listener: () => void): void {
    this.exitListeners.add(listener)
  }

  /**
   * Called whenever the agent sets or clears the session title. A title that arrived while the
   * session was being set up, before anyone listened, is passed to the new listener right away.
   */
  onTitleChange(listener: (title: string | null) => void): void {
    this.titleListeners.add(listener)
    if (this.titleReceived) listener(this.feedback.title)
  }

  /** Every ACP message on this connection, both ways, plus what only the adapter knows. */
  onActivity(listener: (activity: AdapterActivity) => void): void {
    this.activityListeners.add(listener)
  }

  // ── Lifecycle ──

  /**
   * Start the agent and open a session (session/new, or session/load / session/resume for resumeId).
   * The setup phase is capped at 30s. New sessions then apply model / reasoning_effort and send the
   * role prompt; open waits for those without a limit. Tasks are sent with prompt(), never here, so
   * the caller holds the session id before any long-running work starts.
   */
  async open(opts: OpenOptions): Promise<PromptResult> {
    await this.start(opts.config, opts.cwd)
    await this.withLimit(this.establish(opts), this.host.clock.now() + ESTABLISH_LIMIT_MS)
      .then(() => {
        this.toIdle()
        return opts.onEstablished(this.nativeIdValue)
      })
      .catch(async (err: Error) => {
        await this.terminate()
        throw this.toCockpitError(err)
      })
    if (!opts.resumeId) this.bootstrap(opts).catch((err: Error) => this.host.log(`session setup failed: ${err.message}`))
    this.notify()
    return this.waitResult(opts, true)
  }

  /** Start the agent for a native delete only: initialize, no session/new or session/load. */
  private async attach(config: SubagentConfig, cwd: string, nativeId: string): Promise<void> {
    await this.start(config, cwd)
    await this.withLimit(this.initialize(), this.host.clock.now() + ESTABLISH_LIMIT_MS)
      .catch(async (err: Error) => {
        await this.terminate()
        throw this.toCockpitError(err)
      })
    this.nativeIdValue = nativeId
    this.stateValue = 'IDLE'
  }

  private async start(config: SubagentConfig, cwd: string): Promise<void> {
    this.stateValue = 'OPENING'
    const env = this.buildEnv(config)
    const program = await this.locateProgram(config, env)
    // Set after buildEnv so the subagent env cannot point the ACP adapter elsewhere
    const { path_env } = this.spec
    const spec = this.getCommand(config, path_env ? { ...env, [path_env]: program } : env, program)
    const child = this.host.spawn(spec.command, spec.args, { cwd, env: spec.env })
    this.child = child
    child.exited.then(info => this.onExit(info.code, info.signal))
    const stream = ndJsonStream(child.stdin, child.stdout)
    this.conn = new ClientSideConnection(() => this.client(), { readable: this.mirrorReads(stream.readable), writable: this.mirrorWrites(stream.writable) })
  }

  /** Incoming messages pass through unchanged; the activity listeners see each one first. */
  private mirrorReads(readable: ReadableStream<acp.AnyMessage>): ReadableStream<acp.AnyMessage> {
    return readable.pipeThrough(new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform: (message, controller) => {
        this.emit({ kind: 'acp', direction: 'in', message })
        controller.enqueue(message)
      },
    }))
  }

  /**
   * Outgoing messages are reported as they are written. A wrapper rather than pipeTo: close and
   * abort reach the agent's stdin directly, so a closing connection leaves no rejection unhandled.
   */
  private mirrorWrites(writable: WritableStream<acp.AnyMessage>): WritableStream<acp.AnyMessage> {
    const writer = writable.getWriter()
    return new WritableStream<acp.AnyMessage>({
      write: message => {
        this.emit({ kind: 'acp', direction: 'out', message })
        return writer.write(message)
      },
      close: () => writer.close(),
      abort: reason => writer.abort(reason),
    })
  }

  /**
   * Absolute path of the agent program: the subagent path, else spec.program found in PATH.
   * Relative paths are made absolute here because the ACP adapter runs in the session cwd.
   * Throws AGENT_NOT_FOUND / AGENT_VERSION_UNSUPPORTED.
   */
  private async locateProgram(config: SubagentConfig, env: Record<string, string>): Promise<string> {
    const { program, min_version } = this.spec
    const min = min_version.join('.')
    const found = await this.host.findExecutable(config.path || program, env.PATH ?? '')
    if (!found) {
      throw new CockpitError('AGENT_NOT_FOUND', config.path
        ? `${program} not found or not executable at ${config.path}`
        : `${program} not found in PATH; install it or set path in the subagent config`)
    }
    const version = await this.programVersion(found, env)
    if (!version) throw new CockpitError('AGENT_NOT_FOUND', `Cannot run ${found} --version; ${program} ${min}+ is required`)
    if (!versionAtLeast(version, min_version)) {
      throw new CockpitError('AGENT_VERSION_UNSUPPORTED', `${program} ${version.join('.')} at ${found} is too old; ${min}+ is required`)
    }
    return found
  }

  /**
   * x.y.z printed by `<path> --version`; undefined when it fails, prints none or runs past 10s.
   * On timeout it returns right away: a grandchild may keep stdout open long after the kill.
   */
  private async programVersion(path: string, env: Record<string, string>): Promise<number[] | undefined> {
    const child = this.host.spawn(path, ['--version'], { env })
    const finished = Promise.all([new Response(child.stdout).text(), child.exited])
    const timedOut = new Promise<null>(resolve => {
      const timer = this.host.clock.setTimeout(() => resolve(null), VERSION_LIMIT_MS)
      finished.then(() => timer.cancel(), () => timer.cancel())
    })
    const result = await Promise.race([finished, timedOut])
    if (!result) {
      child.kill('SIGKILL')
      return undefined
    }
    const [text, exit] = result
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
    return exit.code === 0 && match ? match.slice(1, 4).map(Number) : undefined
  }

  private async initialize(): Promise<void> {
    const init = await this.connection().initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'subagent-cockpit-mcp', version: '1' },
    })
    this.capabilities = init.agentCapabilities ?? {}
  }

  private async establish(opts: OpenOptions): Promise<void> {
    await this.initialize()
    const conn = this.connection()
    const meta = this.argsMeta(opts.config.args)
    const withMeta = meta ? { _meta: meta } : {}
    if (!opts.resumeId) {
      const created = await conn.newSession({ cwd: opts.cwd, mcpServers: [], ...withMeta })
      this.nativeIdValue = created.sessionId
      this.configOptions = created.configOptions ?? []
      return
    }
    this.nativeIdValue = opts.resumeId
    if (this.capabilities.loadSession) {
      this.loading = true
      const loaded = await conn.loadSession({ sessionId: opts.resumeId, cwd: opts.cwd, mcpServers: [], ...withMeta })
      this.loading = false
      this.configOptions = loaded?.configOptions ?? []
      return
    }
    if (!this.capabilities.sessionCapabilities?.resume) {
      throw new CockpitError('RESUME_NOT_SUPPORTED', 'Agent supports neither session/load nor session/resume')
    }
    const resumed = await conn.resumeSession({ sessionId: opts.resumeId, cwd: opts.cwd, ...withMeta })
    this.configOptions = resumed.configOptions ?? []
  }

  /** Initial config, then the role prompt, both in the background. */
  private async bootstrap(opts: OpenOptions): Promise<void> {
    this.bootstrapping = true
    this.stateValue = 'RUNNING'
    const wanted = this.initialConfig(opts.config)
      .filter(([id, value]) => value && this.configOptions.some(o => o.id === id))
    await wanted.reduce(async (prev, [configId, value]) => {
      await prev
      await this.connection().setSessionConfigOption({ sessionId: this.nativeIdValue, configId, value })
        .then(r => { this.configOptions = r.configOptions })
        .catch((err: Error) => this.host.log(`set ${configId}=${value} failed: ${err.message}`))
    }, Promise.resolve())
    this.bootstrapping = false
    // The session may have been closed while the config requests were in flight
    if (this.state === 'CLOSED') return
    if (this.cancellingValue) {
      this.cancellingValue = false
      this.toIdle()
      this.notify()
      return
    }
    this.startTurn(this.buildInitPrompt(opts.role), true)
  }

  /** Close the session: pending approvals get `cancelled` and questions `cancel`, then the agent process is terminated. */
  async close(): Promise<void> {
    if (this.stateValue === 'CLOSED') return
    this.expectingExit = true
    this.cancelPending()
    this.stateValue = 'CLOSED'
    this.notify()
    await this.terminate()
  }

  /**
   * Stop the agent: let queued responses (e.g. cancelled approvals) reach it, close stdin so it can
   * exit on EOF, then SIGTERM and finally SIGKILL if it is still running.
   */
  private async terminate(): Promise<void> {
    this.expectingExit = true
    this.stateValue = 'CLOSED'
    const child = this.child
    if (!child) return
    await new Promise<void>(resolve => this.host.clock.setTimeout(resolve, 0))
    child.end()
    const timers = [
      this.host.clock.setTimeout(() => child.kill('SIGTERM'), EOF_GRACE_MS),
      this.host.clock.setTimeout(() => child.kill('SIGKILL'), EOF_GRACE_MS + KILL_GRACE_MS),
    ]
    await child.exited
    timers.forEach(t => t.cancel())
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.expectingExit) return
    this.host.log(`agent exited unexpectedly (code=${code}, signal=${signal})`)
    this.cancelPending()
    this.stateValue = 'CLOSED'
    this.cancellingValue = false
    this.exitListeners.forEach(l => l())
    this.notify()
  }

  // ── Turns ──

  private startTurn(text: string, internal: boolean): number {
    const turnId = ++counters.turn
    this.stateValue = 'RUNNING'
    this.currentTurn = { turn_id: turnId, internal, output: '', tool_calls: new Map(), message_id: null, tool_since_message: false }
    this.emit({ kind: 'turn_started', turn_id: turnId, internal })
    this.connection().prompt({ sessionId: this.nativeIdValue, prompt: [{ type: 'text', text }] }).then(
      r => this.finishTurn(turnId, r.stopReason === 'cancelled' ? 'cancelled' : 'done'),
      (err: Error) => this.finishTurn(turnId, 'error', err),
    )
    this.notify()
    return turnId
  }

  private finishTurn(turnId: number, outcome: TurnOutcome, err?: Error): void {
    const turn = this.currentTurn
    if (this.stateValue === 'CLOSED' || turn?.turn_id !== turnId) return
    // A dropped connection means the process is going away; onExit handles that
    if (err && this.conn?.signal.aborted) return
    this.lastTurn = {
      turn_id: turnId,
      internal: turn.internal,
      outcome,
      output: turn.output,
      error: err ? this.toCockpitError(err) : undefined,
    }
    this.cancelPending()
    this.cancellingValue = false
    this.toIdle()
    this.emit({ kind: 'turn_finished', turn_id: turnId, outcome, error: this.lastTurn.error?.message ?? null })
    if (!turn.internal) this.notices.set(`turn:${turnId}`, { item: { type: 'turn', turn_id: turnId, outcome }, delivered: false })
    this.notify()
  }

  /**
   * Send a prompt. In ASKING or QUESTIONING the next pending approval or question is returned instead.
   * wait=false returns `running` right after sending. Otherwise waits until done, an approval or a
   * question, without a limit.
   */
  prompt(text: string, wait: boolean, opts: WaitOptions): Promise<PromptResult> {
    if (this.stateValue === 'ASKING' || this.stateValue === 'QUESTIONING') return Promise.resolve(this.currentResult(wait, opts.signal) ?? this.running())
    this.assertOpen()
    if (this.busy || this.stateValue !== 'IDLE') throw new CockpitError('SESSION_BUSY', 'Session is busy')
    if (!text.trim()) throw new CockpitError('INVALID_STATE', 'Prompt text is empty')
    const turnId = this.startTurn(text, false)
    if (!wait) return Promise.resolve({ status: 'running', turn_id: turnId })
    return this.waitResult(opts, true)
  }

  /** Wait for the current turn: done, an approval, or the optional deadline (then `running`). */
  wait(opts: WaitOptions): Promise<PromptResult> {
    this.assertOpen()
    return this.waitResult(opts, true)
  }

  /**
   * Answer one approval. Already-handled ids return the current state without answering again;
   * ids never issued raise INVALID_OPTION. approve takes an explicit option_id when given.
   *
   * allow means "don't ask again in this session". It uses the agent's own session-scoped option
   * when sessionAllowOption() finds one. Otherwise it answers allow_once and keeps an allow rule
   * in this adapter, so later matching requests are answered without asking. It never picks an
   * agent option that persists beyond the session.
   */
  respond(verb: ApprovalVerb, approvalId: string, optionId: string | undefined, wait: boolean, opts: WaitOptions): Promise<PromptResult> {
    if (this.handledApprovals.has(approvalId)) return Promise.resolve(this.currentResult(wait, opts.signal) ?? this.running())
    const pending = this.approvals.get(approvalId)
    if (!pending) throw new CockpitError('INVALID_OPTION', `Unknown approval_id: ${approvalId}`)
    const options = pending.info.options
    const native = verb === 'allow' ? this.sessionAllowOption(options) : undefined
    const option = optionId
      ? options.find(o => o.option_id === optionId)
      : native ?? this.pickOption(verb === 'allow' ? 'approve' : verb, options)
    if (!option) {
      throw new CockpitError('INVALID_OPTION', `No matching option (${optionId ?? VERB_KINDS[verb]}); available: ${options.map(o => `${o.option_id}(${o.kind})`).join(', ')}`)
    }
    this.answerApproval(approvalId, { outcome: 'selected', optionId: option.option_id }, verb)
    if (verb === 'allow' && !native) this.remember(this.allowRule(pending.request))
    if (!wait) return Promise.resolve(this.currentResult(false) ?? this.running())
    return this.waitResult(opts, true)
  }

  /**
   * Answer one question. Already-answered ids return the current state without answering again;
   * ids never issued raise INVALID_OPTION. content goes to the agent as given; the agent checks it.
   */
  answerQuestion(questionId: string, action: AnswerAction, content: AnswerContent | undefined, wait: boolean, opts: WaitOptions): Promise<PromptResult> {
    if (this.handledQuestions.has(questionId)) return Promise.resolve(this.currentResult(wait, opts.signal) ?? this.running())
    if (!this.questions.has(questionId)) throw new CockpitError('INVALID_OPTION', `Unknown question_id: ${questionId}`)
    this.answerOne(questionId, action === 'accept' ? { action, content: content ?? {} } : { action })
    if (!wait) return Promise.resolve(this.currentResult(false) ?? this.running())
    return this.waitResult(opts, true)
  }

  /** Keep an allow rule and answer the pending approvals it already covers. */
  private remember(rule: AllowRule): void {
    this.allowRules.push(rule)
    const covered = [...this.approvals.entries()].flatMap(([id, p]) => {
      const once = p.info.options.find(o => o.kind === 'allow_once')
      return once && rule.matches(p.request) ? [{ id, title: p.info.title, optionId: once.option_id }] : []
    })
    covered.forEach(({ id, title, optionId }) => {
      this.pushEvent({ type: 'auto_approved', text: title })
      this.answerApproval(id, { outcome: 'selected', optionId }, 'allow')
    })
  }

  /** Cancel the current turn. Pending approvals get `cancelled` and questions `cancel`, then session/cancel is sent. */
  cancel(): { status: 'cancelling' | 'done' } {
    this.assertOpen()
    if (!this.busy) return { status: 'done' }
    this.cancelPending()
    this.cancellingValue = true
    this.stateValue = 'RUNNING'
    // The cancelled approval responses are written after pending microtasks; send session/cancel
    // behind them, and only if that same turn is still running by then
    const conn = this.connection()
    const turnId = this.currentTurn?.turn_id
    this.cancelSent = new Promise<void>(resolve => this.host.clock.setTimeout(() => {
      resolve()
      if (!this.busy || this.currentTurn?.turn_id !== turnId) return
      conn.cancel({ sessionId: this.nativeIdValue }).catch((err: Error) => this.host.log(`session/cancel failed: ${err.message}`))
    }, 0))
    this.notify()
    return { status: 'cancelling' }
  }

  /** Change one config option. Unknown ids and values not offered by a select option raise INVALID_OPTION. */
  async setConfig(configId: string, value: string): Promise<ConfigOptionInfo[]> {
    this.assertOpen()
    const option = this.configOptions.find(o => o.id === configId)
    if (!option) throw new CockpitError('INVALID_OPTION', `Unknown config_id: ${configId}; available: ${this.configOptions.map(o => o.id).join(', ')}`)
    const choices = toConfigInfo(option).options.map(o => o.value)
    if (option.type !== 'boolean' && !choices.includes(value)) {
      throw new CockpitError('INVALID_OPTION', `Unknown value for ${configId}: ${value}; available: ${choices.join(', ')}`)
    }
    const request: acp.SetSessionConfigOptionRequest = option.type === 'boolean'
      ? { sessionId: this.nativeIdValue, configId, type: 'boolean', value: value === 'true' }
      : { sessionId: this.nativeIdValue, configId, value }
    const response = await this.connection().setSessionConfigOption(request).catch((err: Error) => {
      throw this.toCockpitError(err)
    })
    this.configOptions = response.configOptions
    this.notify()
    return this.configs
  }

  // ── Native sessions ──

  /**
   * Native session operations. Default: an open adapter deletes over its own connection; an
   * unstarted one acts as the temporary agent itself. The adapters involved end up closed.
   */
  getNativeSessionManager(): NativeSessionManager {
    return { delete: session => (this.started ? this.deleteOpenSession() : this.deleteThrough(this, session)) }
  }

  /** Finish the current turn, delete over this adapter's connection, then close it. */
  protected async deleteOpenSession(): Promise<NativeDeleteResult> {
    try {
      await this.settleForDelete()
      return await this.deleteNative()
    } finally {
      await this.close()
    }
  }

  /** Delete through `temporary`, an unstarted adapter: attach, session/delete, then close it. */
  protected async deleteThrough(temporary: SubagentAdapter, session: NativeSession): Promise<NativeDeleteResult> {
    try {
      await temporary.attach(session.config, session.cwd, session.nativeId)
      return await temporary.deleteNative()
    } finally {
      await temporary.close()
    }
  }

  /**
   * End the current turn before a delete: cancel approvals and the turn, then wait for
   * session/prompt to return, up to 10s. Throws AGENT_ERROR on timeout.
   */
  protected async settleForDelete(): Promise<void> {
    if (!this.busy) return
    this.cancel()
    await this.cancelSent
    const settled = await this.waitUntil(() => (this.busy ? undefined : true), { deadline: this.host.clock.now() + CANCEL_CONFIRM_MS })
    if (!settled) throw new CockpitError('AGENT_ERROR', 'Agent did not confirm the cancel within 10s')
  }

  /**
   * Send the native delete over the open connection. Default: ACP session/delete when the agent declares it.
   * Returns false when the agent has no delete. Agents with their own delete method override it.
   */
  protected async requestNativeDelete(conn: ClientSideConnection, sessionId: string): Promise<boolean> {
    if (!this.capabilities.sessionCapabilities?.delete) return false
    await conn.deleteSession({ sessionId })
    return true
  }

  /** Delete the native session over the open connection. */
  private async deleteNative(): Promise<NativeDeleteResult> {
    const sent = await this.requestNativeDelete(this.connection(), this.nativeIdValue).catch((err: Error) => {
      throw this.toCockpitError(err)
    })
    return sent ? this.nativeDeleteResult() : 'unsupported'
  }

  // ── Snapshot ──

  /** Events after `since` (all retained events when undefined). */
  eventsSince(since?: number): SessionEvent[] {
    return since === undefined ? [...this.events] : this.events.filter(e => e.seq > since)
  }

  /** True when events after `since` were dropped from the buffer. */
  lostSince(since: number): boolean {
    return this.droppedSeq > since
  }

  view(): SessionView {
    const turn = this.currentTurn
    return {
      turn_id: turn?.turn_id ?? null,
      output: turn?.output ?? '',
      tool_calls: turn ? [...turn.tool_calls.values()] : [],
    }
  }

  /** Undelivered notifications, keyed `turn:<id>` / `approval:<id>` / `question:<id>`. */
  undelivered(): Array<{ id: string; item: Omit<NotificationItem, 'key'> }> {
    return [...this.notices.entries()].filter(([, n]) => !n.delivered).map(([id, n]) => ({ id, item: n.item }))
  }

  /** Mark a notification as relayed to the main agent (snapshot ack). */
  acknowledge(id: string): void {
    this.notices.delete(id)
  }

  // ── Waiting ──

  private running(): PromptResult {
    return { status: 'running', turn_id: this.currentTurn?.turn_id }
  }

  /**
   * Current result, or undefined while the turn is still running. Approvals come before questions,
   * each in arrival order. With `deliver`, the returned turn, approval or question is marked
   * delivered — unless the MCP request was cancelled.
   */
  private currentResult(deliver: boolean, signal?: AbortSignal): PromptResult | undefined {
    if (this.stateValue === 'CLOSED') throw new CockpitError('SUBAGENT_EXITED', 'Agent process exited')
    const mark = (id: string) => deliver && !signal?.aborted && this.notices.delete(id)
    const approval = this.approvals.values().next().value
    if (approval) {
      mark(`approval:${approval.info.approval_id}`)
      return { status: 'approval_needed', turn_id: this.currentTurn?.turn_id, approval: approval.info }
    }
    const question = this.questions.values().next().value
    if (question) {
      mark(`question:${question.info.question_id}`)
      return { status: 'question_needed', turn_id: this.currentTurn?.turn_id, question: question.info }
    }
    if (this.busy) return undefined
    const last = this.lastTurn
    if (!last) return { status: 'done' }
    mark(`turn:${last.turn_id}`)
    if (last.error) throw last.error
    return last.internal
      ? { status: 'done', turn_id: last.turn_id, outcome: last.outcome }
      : { status: 'done', turn_id: last.turn_id, outcome: last.outcome, output: last.output }
  }

  private async waitResult(opts: WaitOptions, deliver: boolean): Promise<PromptResult> {
    const result = await this.waitUntil(() => this.currentResult(deliver, opts.signal), opts)
    return result ?? this.running()
  }

  /**
   * Resolve with check()'s value once it is defined, null at the deadline. The check runs on
   * every state change. Aborting the signal rejects and withdraws the waiter.
   */
  private waitUntil<T>(check: () => T | undefined, opts: WaitOptions): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      const first = check()
      if (first !== undefined) return resolve(first)
      if (opts.signal?.aborted) return reject(new Error('Request cancelled'))
      const deadline = opts.deadline ?? Infinity
      const remaining = deadline - this.host.clock.now()
      if (remaining <= 0) return resolve(null)
      const finish = (fn: () => void) => {
        this.listeners.delete(listener)
        timer?.cancel()
        opts.signal?.removeEventListener('abort', onAbort)
        this.waiters--
        fn()
      }
      const listener = () => {
        try {
          const value = check()
          if (value !== undefined) finish(() => resolve(value))
        } catch (err) {
          finish(() => reject(err))
        }
      }
      const onAbort = () => finish(() => reject(new Error('Request cancelled')))
      const timer = Number.isFinite(deadline) ? this.host.clock.setTimeout(() => finish(() => resolve(null)), remaining) : null
      this.waiters++
      this.listeners.add(listener)
      opts.signal?.addEventListener('abort', onAbort)
    })
  }

  private notify(): void {
    const state = `${this.stateValue}:${this.cancellingValue}`
    if (state !== this.lastActivityState) {
      this.lastActivityState = state
      this.emit({ kind: 'state', state: this.stateValue, cancelling: this.cancellingValue })
    }
    [...this.listeners].forEach(l => l())
  }

  /** A failing activity listener is logged; it must never break the ACP connection or the turn. */
  private emit(activity: AdapterActivity): void {
    this.activityListeners.forEach(listener => {
      try {
        listener(activity)
      } catch (err) {
        this.host.log(`activity listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  private toIdle(): void {
    this.stateValue = 'IDLE'
    this.idleSinceValue = this.host.clock.now()
  }

  /** Race a setup step against an absolute time limit. */
  private withLimit<T>(work: Promise<T>, limit: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.host.clock.setTimeout(
        () => reject(new CockpitError('AGENT_ERROR', 'Agent did not finish session setup within 30s')),
        Math.max(0, limit - this.host.clock.now()),
      )
      this.child?.exited.then(() => reject(new CockpitError('SUBAGENT_EXITED', 'Agent process exited during setup')))
      work.then(resolve, reject).finally(() => timer.cancel())
    })
  }

  // ── Approvals and questions ──

  private answerApproval(approvalId: string, outcome: acp.RequestPermissionOutcome, resolution: ApprovalResolution): void {
    const pending = this.approvals.get(approvalId)
    if (!pending) return
    this.approvals.delete(approvalId)
    this.handledApprovals.add(approvalId)
    this.notices.delete(`approval:${approvalId}`)
    this.emit({ kind: 'approval_resolved', approval_id: approvalId, resolution, option_id: outcome.outcome === 'selected' ? outcome.optionId : null })
    pending.respond(outcome)
    this.refreshPendingState()
    this.notify()
  }

  private answerOne(questionId: string, response: acp.CreateElicitationResponse & { action: AnswerAction }): void {
    const pending = this.questions.get(questionId)
    if (!pending) return
    this.questions.delete(questionId)
    this.handledQuestions.add(questionId)
    this.notices.delete(`question:${questionId}`)
    this.emit({ kind: 'question_resolved', question_id: questionId, action: response.action })
    pending.respond(response)
    this.refreshPendingState()
    this.notify()
  }

  /** ASKING while approvals wait, else QUESTIONING while questions wait, else RUNNING. Other states stay. */
  private refreshPendingState(): void {
    if (this.stateValue !== 'RUNNING' && this.stateValue !== 'ASKING' && this.stateValue !== 'QUESTIONING') return
    this.stateValue = this.approvals.size > 0 ? 'ASKING' : this.questions.size > 0 ? 'QUESTIONING' : 'RUNNING'
  }

  /** Every waiting request gets its cancel answer: approvals `cancelled`, questions `cancel`. */
  private cancelPending(): void {
    [...this.approvals.keys()].forEach(id => this.answerApproval(id, { outcome: 'cancelled' }, 'cancelled'))
    ;[...this.questions.keys()].forEach(id => this.answerOne(id, { action: 'cancel' }))
  }

  // ── ACP client side ──

  private client(): acp.Client {
    return {
      requestPermission: params => this.onPermission(params),
      createElicitation: params => this.onQuestion(params),
      // Only URL mode completes this way, and URL mode is not advertised
      completeElicitation: async () => undefined,
      sessionUpdate: async params => this.onUpdate(params.update),
    }
  }

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (this.stateValue === 'CLOSED') return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    // Covered by an earlier `allow` in this session: answer allow_once without asking
    const once = this.allowRules.some(r => r.matches(params)) ? params.options.find(o => o.kind === 'allow_once') : undefined
    if (once) {
      this.emit({ kind: 'auto_approved', tool_call_id: params.toolCall.toolCallId, option_id: once.optionId })
      this.pushEvent({ type: 'auto_approved', text: params.toolCall.title ?? '' })
      this.notify()
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: once.optionId } })
    }
    const approvalId = `ap_${++counters.approval}`
    const { toolCall } = params
    const info: ApprovalInfo = {
      approval_id: approvalId,
      tool_call_id: toolCall.toolCallId,
      title: toolCall.title ?? '',
      kind: toolCall.kind ?? null,
      options: params.options.map(o => ({ option_id: o.optionId, name: o.name, kind: o.kind })),
    }
    return new Promise(resolve => {
      this.approvals.set(approvalId, { info, request: params, respond: outcome => resolve({ outcome }) })
      this.notices.set(`approval:${approvalId}`, { item: { type: 'approval', approval: info }, delivered: false })
      this.emit({ kind: 'approval', approval_id: approvalId, tool_call_id: toolCall.toolCallId })
      this.refreshPendingState()
      this.pushEvent({ type: 'approval', text: info.title })
      this.notify()
    })
  }

  private onQuestion(params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    // Only form mode is advertised; ACP answers any other mode with Invalid params
    if (params.mode !== 'form' || !('requestedSchema' in params)) {
      this.declineQuestion(params.message)
      return Promise.reject(RequestError.invalidParams(undefined, `Unsupported elicitation mode: ${params.mode}`))
    }
    // Only a running turn has a registered session the caller can answer through. Request-scoped
    // questions, and questions while opening, idle or closed, would wait for nobody.
    const inTurn = this.stateValue === 'RUNNING' || this.stateValue === 'ASKING' || this.stateValue === 'QUESTIONING'
    if (!inTurn || !('sessionId' in params)) {
      this.declineQuestion(params.message)
      return Promise.resolve({ action: 'cancel' })
    }
    const questionId = `qu_${++counters.question}`
    const info: QuestionInfo = {
      question_id: questionId,
      tool_call_id: typeof params.toolCallId === 'string' ? params.toolCallId : null,
      message: params.message,
      // A plain JSON copy, passed to the caller exactly as the agent sent it
      requested_schema: JSON.parse(JSON.stringify(params.requestedSchema)),
    }
    return new Promise(resolve => {
      this.questions.set(questionId, { info, respond: resolve })
      this.notices.set(`question:${questionId}`, { item: { type: 'question', question: info }, delivered: false })
      this.emit({ kind: 'question', question_id: questionId })
      this.refreshPendingState()
      this.pushEvent({ type: 'question', text: info.message })
      this.notify()
    })
  }

  /** A question that never enters the queue leaves only an event behind. */
  private declineQuestion(message: string): void {
    this.pushEvent({ type: 'question_declined', text: message })
    this.notify()
  }

  private onUpdate(update: acp.SessionUpdate): void {
    const turn = this.loading ? undefined : this.currentTurn
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content)
        if (turn && text) appendMessage(turn, text, update.messageId ?? null)
        this.pushEvent({ type: 'message', text })
        break
      }
      case 'agent_thought_chunk':
        this.pushEvent({ type: 'thought', text: textOf(update.content) })
        break
      case 'user_message_chunk':
        this.pushEvent({ type: 'user_message', text: textOf(update.content) })
        break
      case 'tool_call':
      case 'tool_call_update': {
        const previous = turn?.tool_calls.get(update.toolCallId)
        const view: ToolCallView = {
          tool_call_id: update.toolCallId,
          title: update.title ?? previous?.title ?? '',
          kind: update.kind ?? previous?.kind ?? null,
          status: update.status ?? previous?.status ?? null,
        }
        if (turn) {
          turn.tool_calls.set(update.toolCallId, view)
          turn.tool_since_message = true
        }
        this.pushEvent({ type: update.sessionUpdate, tool_call: view })
        break
      }
      case 'config_option_update':
        this.configOptions = update.configOptions
        this.pushEvent({ type: 'config' })
        break
      case 'plan':
        this.feedback.plan = update.entries.map(({ content, priority, status }) => ({ content, priority, status }))
        this.pushEvent({ type: 'plan', plan: this.feedback.plan })
        break
      case 'usage_update':
        // Sent around every tool call by Claude: kept as the latest value, never as an event
        this.feedback.usage = { used: update.used, size: update.size, cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null }
        break
      case 'session_info_update':
        if (update.title === undefined) break
        // The first explicit title always goes through, a clear included: the stored record may hold
        // an older title than this adapter's initial null
        if (this.titleReceived && update.title === this.feedback.title) break
        this.titleReceived = true
        this.feedback.title = update.title
        this.pushEvent({ type: 'session_info', text: update.title ?? '' })
        this.titleListeners.forEach(l => l(update.title ?? null))
        break
      case 'current_mode_update':
        this.pushEvent({ type: 'mode', text: update.currentModeId })
        break
      case 'available_commands_update':
        this.feedback.commands = update.availableCommands.map(({ name, description }) => ({ name, description }))
        this.pushEvent({ type: 'commands' })
        break
      default:
        this.pushEvent({ type: update.sessionUpdate })
    }
    this.notify()
  }

  private pushEvent(event: Omit<SessionEvent, 'seq' | 'turn_id' | 'replay'>): void {
    const replay = this.loading
    this.events.push({ seq: ++counters.seq, turn_id: replay ? null : this.currentTurn?.turn_id ?? null, replay, ...event })
    const overflow = this.events.length - EVENT_LIMIT
    if (overflow > 0) this.droppedSeq = this.events.splice(0, overflow)[overflow - 1].seq
  }

  // ── Helpers ──

  private connection(): ClientSideConnection {
    if (!this.conn) throw new CockpitError('INVALID_STATE', 'Agent is not started')
    return this.conn
  }

  private assertOpen(): void {
    if (this.stateValue === 'CLOSED') throw new CockpitError('SUBAGENT_EXITED', 'Agent process exited')
    if (this.stateValue === 'OPENING') throw new CockpitError('INVALID_STATE', 'Session is still opening')
  }

  protected toCockpitError(err: Error): CockpitError {
    if (err instanceof CockpitError) return err
    if (err instanceof RequestError) {
      return err.code === AUTH_REQUIRED_CODE ? this.onAuthRequired(err) : new CockpitError('AGENT_ERROR', `Agent error ${err.code}: ${err.message}`)
    }
    if (this.conn?.signal.aborted) return new CockpitError('SUBAGENT_EXITED', 'Agent process exited')
    return new CockpitError('AGENT_ERROR', err.message)
  }
}
