import { CockpitError, createAdapter, currentSeq } from '../adapter/adapter'
import type { AdapterActivity, ApprovalVerb, SubagentAdapter } from '../adapter/adapter'
import { resolveSubagent } from '../config'
import type { Host, Timer } from '../host/host'
import type {
  AnswerAction, AnswerContent, AppConfig, CancelResult, CloseResult, ConfigOptionInfo, DeleteResult, ConversationActivity,
  OpenParams, OpenResult, OutputResult, ProgressResult, PromptResult, SessionCloseReason, SessionSnapshot,
  SessionState, SessionStatus, SessionSummary, SnapshotParams, SnapshotResult, SubagentConfig, SubagentInfo,
} from '../types'
import { SessionStore } from './session-store'

/** One session's activity, as the monitor receives it. */
export interface SessionActivity {
  session: string
  activity: AdapterActivity | Extract<ConversationActivity, { kind: 'session_opened' | 'session_closed' }>
}

/** Called once the session is registered: announces it, then releases the activity held until then. */
type Announce = (session: string, subagent: string, cwd: string, reconnected: boolean) => void

interface OpenSession {
  id: string
  adapter: SubagentAdapter
  subagent: string
  cwd: string
}

const NOTICE_KEY = /^(?<server>[^:]+):(?<session>[^:]+):(?<id>(?:turn|approval|question):.+)$/
const LAST_PROMPT_LENGTH = 100

/**
 * Session registry for one MCP server process. The in-memory map is the source of truth and holds
 * only sessions this process opened; other processes' sessions are visible on disk only.
 * Cross-process ownership is the lock.pid file in each session directory.
 */
export class SessionManager {
  readonly serverId = crypto.randomUUID()
  private readonly sessions = new Map<string, OpenSession>()
  private readonly store: SessionStore
  private readonly idleTimer?: Timer
  private readonly activityListeners = new Set<(activity: SessionActivity) => void>()

  constructor(private readonly host: Host, private readonly config: AppConfig, home: string) {
    this.store = new SessionStore(host, home)
    // Check every tenth of the timeout, kept within 1 to 60 seconds.
    const checkEvery = Math.min(Math.max(config.idle.timeout / 10, 1), 60)
    this.idleTimer = config.idle.timeout > 0
      ? host.clock.setInterval(() => this.closeIdle(), checkEvery * 1000)
      : undefined
  }

  // ── Activity ──

  /** Subscribe to every session's activity; returns the unsubscribe function. */
  onActivity(listener: (activity: SessionActivity) => void): () => void {
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }

  /** session_opened for every open session, for a monitor that connects late. */
  openedSessions(): SessionActivity[] {
    return [...this.sessions.values()].map(({ id, adapter, subagent, cwd }) => ({
      session: id,
      activity: {
        kind: 'session_opened',
        subagent,
        adapter: SessionStore.parseId(id)?.adapter ?? '',
        cwd,
        title: adapter.title,
        state: adapter.state,
        reconnected: false,
      },
    }))
  }

  /**
   * Hold the adapter's activity until the session is registered, then send session_opened and the
   * held activity in order. Activity of a session that never registers is dropped with the adapter.
   */
  private watch(adapter: SubagentAdapter, adapterName: string): Announce {
    const held: AdapterActivity[] = []
    const bound = { session: '' }
    adapter.onActivity(activity => (bound.session ? this.publish({ session: bound.session, activity }) : held.push(activity)))
    return (session, subagent, cwd, reconnected) => {
      bound.session = session
      this.publish({ session, activity: { kind: 'session_opened', subagent, adapter: adapterName, cwd, title: adapter.title, state: adapter.state, reconnected } })
      held.splice(0).forEach(activity => this.publish({ session, activity }))
    }
  }

  private publish(activity: SessionActivity): void {
    this.activityListeners.forEach(listener => listener(activity))
  }

  // ── Listing ──

  /** Configured subagents as written; profiles are not resolved and env values never leave the server. */
  subagents(): SubagentInfo[] {
    return Object.entries(this.config.subagents).map(([name, sub]) => ({
      name,
      adapter: sub.adapter || 'codex',
      description: sub.description ?? '',
      profile: sub.profile ?? '',
    }))
  }

  /** Sessions on disk, most recent first. State comes from this process; others show CLOSED. */
  async list(cwd?: string, status?: string): Promise<SessionSummary[]> {
    const stored = await this.store.list()
    const rows = await Promise.all(stored.map(async ({ id, record }) => ({
      session: id,
      ...record,
      title: record.title ?? '',
      state: this.sessions.get(id)?.adapter.state ?? 'CLOSED',
      in_use: this.sessions.has(id) || await this.store.lockedByOther(id),
    })))
    return rows.filter(r => (!cwd || r.cwd === cwd) && (!status || r.state === status))
  }

  // ── Open ──

  /**
   * Open a session. Priority: explicit `session` reconnects > `reuse` takes this process's
   * longest-idle IDLE session with the same cwd and subagent > create new. No task is sent here;
   * the caller gets the session id first and sends tasks with prompt().
   */
  async open(params: OpenParams, signal?: AbortSignal): Promise<OpenResult> {
    const sub = resolveSubagent(this.config, params.subagent)
    if (params.session) return this.reconnect(params.session, signal)
    const candidate = params.reuse
      ? [...this.sessions.values()]
        .filter(s => s.cwd === params.cwd && s.subagent === params.subagent && s.adapter.state === 'IDLE' && !s.adapter.busy)
        .sort((a, b) => a.adapter.idleSince - b.adapter.idleSince)[0]
      : undefined
    if (candidate) return this.opened(candidate.id, true, { status: 'done' }, candidate.adapter)
    return this.create(params, sub, signal)
  }

  private async create(params: OpenParams, sub: SubagentConfig, signal?: AbortSignal): Promise<OpenResult> {
    const adapter = createAdapter(sub.adapter, this.host)
    const announce = this.watch(adapter, sub.adapter)
    const role = params.role ?? sub.role
    const opened = { id: '' }
    try {
      const result = await adapter.open({
        config: sub,
        cwd: params.cwd,
        role,
        signal,
        onEstablished: async nativeId => {
          const id = SessionStore.sessionId(sub.adapter, nativeId)
          const now = this.timestamp()
          await this.store.create(id, {
            subagent: params.subagent,
            cwd: params.cwd,
            role,
            created_at: now,
            last_prompt: '',
            last_at: now,
          })
          if (!await this.store.acquireLock(id)) throw new CockpitError('SESSION_IN_USE', `Session ${id} is open in another process`)
          opened.id = id
          this.register(id, adapter, params.subagent, params.cwd)
          announce(id, params.subagent, params.cwd, false)
        },
      })
      return this.opened(opened.id, false, result, adapter)
    } catch (err) {
      if (opened.id && !this.sessions.has(opened.id)) await this.store.releaseLock(opened.id)
      throw err
    }
  }

  /** Reconnect. A session already open in this process returns its current state right away. */
  private async reconnect(id: string, signal?: AbortSignal): Promise<OpenResult> {
    const open = this.sessions.get(id)
    if (open) return this.opened(id, false, await open.adapter.wait({ deadline: this.host.clock.now(), signal }), open.adapter)
    const parsed = SessionStore.parseId(id)
    if (!parsed || !await this.store.exists(id)) throw new CockpitError('SESSION_NOT_FOUND', `Session not found: ${id}`)
    const record = await this.store.read(id)
    // The session's own subagent, resolved from the current config
    const config = resolveSubagent(this.config, record.subagent)
    if (!await this.store.acquireLock(id)) throw new CockpitError('SESSION_IN_USE', `Session ${id} is open in another process`)
    const adapter = createAdapter(parsed.adapter, this.host)
    const announce = this.watch(adapter, parsed.adapter)
    try {
      const result = await adapter.open({
        config,
        cwd: record.cwd,
        role: record.role,
        resumeId: parsed.native,
        signal,
        onEstablished: async () => {
          this.register(id, adapter, record.subagent, record.cwd)
          announce(id, record.subagent, record.cwd, true)
        },
      })
      return this.opened(id, false, result, adapter)
    } catch (err) {
      if (!this.sessions.has(id)) await this.store.releaseLock(id)
      throw err
    }
  }

  private opened(session: string, reused: boolean, result: PromptResult, adapter: SubagentAdapter): OpenResult {
    return { session, reused, ...result, config_options: adapter.configs }
  }

  private register(id: string, adapter: SubagentAdapter, subagent: string, cwd: string): void {
    this.sessions.set(id, { id, adapter, subagent, cwd })
    adapter.onUnexpectedExit(() => {
      this.sessions.delete(id)
      this.publish({ session: id, activity: { kind: 'session_closed', reason: 'exited' } })
      // Pending session.json writes finish before the lock goes, so no write lands after another process takes over
      this.store.flush(id)
        .then(() => this.store.releaseLock(id))
        .catch((err: Error) => this.host.log(`release lock of ${id} failed: ${err.message}`))
    })
    // Persist the agent's title for `sessions`; a title received while opening arrives here at once
    adapter.onTitleChange(title => {
      this.store.update(id, { title: title ?? '' }).catch((err: Error) => this.host.log(`save title of ${id} failed: ${err.message}`))
    })
  }

  // ── Turns and approvals ──

  async prompt(id: string, text: string, wait: boolean, signal?: AbortSignal): Promise<PromptResult> {
    const open = this.get(id)
    const sends = open.adapter.state === 'IDLE'
    const pending = open.adapter.prompt(text, wait, { signal })
    const recorded = sends ? this.store.update(open.id, { last_prompt: text.slice(0, LAST_PROMPT_LENGTH), last_at: this.timestamp() }) : undefined
    // Subscribe to both right away so a fast failure of the turn is never an unhandled rejection
    const [result] = await Promise.all([pending, recorded])
    return result
  }

  async respond(verb: ApprovalVerb, id: string, approvalId: string, optionId: string | undefined, wait: boolean, signal?: AbortSignal): Promise<PromptResult> {
    return this.get(id).adapter.respond(verb, approvalId, optionId, wait, { signal })
  }

  async answer(id: string, questionId: string, action: AnswerAction, content: AnswerContent | undefined, wait: boolean, signal?: AbortSignal): Promise<PromptResult> {
    return this.get(id).adapter.answerQuestion(questionId, action, content, wait, { signal })
  }

  /** The agent's latest execution feedback; the main agent calls it only when it wants it. */
  progress(id: string): ProgressResult {
    const { adapter } = this.get(id)
    return { plan: adapter.plan, usage: adapter.usage, title: adapter.title, commands: adapter.commands }
  }

  cancel(id: string): CancelResult {
    return this.get(id).adapter.cancel()
  }

  async setConfig(id: string, configId: string, value: string): Promise<ConfigOptionInfo[]> {
    return this.get(id).adapter.setConfig(configId, value)
  }

  /** Session state with the current value of each config option; the choices are left out. */
  status(id: string): SessionStatus {
    const open = this.get(id)
    return { ...this.stateOf(open), config: Object.fromEntries(open.adapter.configs.map(o => [o.id, o.current_value])) }
  }

  output(id: string): OutputResult {
    return this.get(id).adapter.lastOutput
  }

  // ── Close and delete ──

  /** Close one session, or all when id is omitted. Session directories are kept. */
  async close(id?: string): Promise<CloseResult> {
    const targets = id ? [this.get(id)] : [...this.sessions.values()]
    await Promise.all(targets.map(s => this.closeSession(s, 'closed')))
    return { closed: targets.map(s => s.id) }
  }

  private async closeSession(open: OpenSession, reason: SessionCloseReason): Promise<void> {
    this.sessions.delete(open.id)
    await open.adapter.close()
    this.publish({ session: open.id, activity: { kind: 'session_closed', reason } })
    await this.store.flush(open.id)
    await this.store.releaseLock(open.id)
  }

  /**
   * Delete the native session through the adapter's native session manager, then the session
   * directory. lock.pid is held throughout. The agent ends up closed either way; on failure the
   * directory and session.json stay for a retry.
   */
  async delete(id: string): Promise<DeleteResult> {
    const open = this.sessions.get(id)
    const parsed = SessionStore.parseId(id)
    if (!parsed || !await this.store.exists(id)) throw new CockpitError('SESSION_NOT_FOUND', `Session not found: ${id}`)
    if (!open && !await this.store.acquireLock(id)) throw new CockpitError('SESSION_IN_USE', `Session ${id} is open in another process`)
    const record = await this.store.read(id)
    const config = resolveSubagent(this.config, record.subagent)
    const adapter = open?.adapter ?? createAdapter(parsed.adapter, this.host)
    this.sessions.delete(id)
    try {
      const native = await adapter.getNativeSessionManager().delete({
        nativeId: parsed.native,
        cwd: record.cwd,
        config,
        temporary: () => createAdapter(parsed.adapter, this.host),
      })
      await this.store.remove(id)
      open && this.publish({ session: id, activity: { kind: 'session_closed', reason: 'deleted' } })
      return { session: id, native }
    } catch (err) {
      await this.store.releaseLock(id)
      throw err
    }
  }

  /** Close every session, releasing their locks. Called when the MCP server exits. */
  async shutdown(): Promise<void> {
    this.idleTimer?.cancel()
    await Promise.all([...this.sessions.values()].map(s => this.closeSession(s, 'shutdown')))
  }

  private closeIdle(): void {
    const limit = this.config.idle.timeout * 1000
    const now = this.host.clock.now()
    const stale = [...this.sessions.values()]
      .filter(s => s.adapter.state === 'IDLE' && !s.adapter.busy && !s.adapter.waiting && now - s.adapter.idleSince >= limit)
    stale.forEach(s => {
      this.host.log(`closing idle session ${s.id}`)
      this.closeSession(s, 'idle').catch((err: Error) => this.host.log(`close ${s.id} failed: ${err.message}`))
    })
  }

  // ── Snapshot ──

  /**
   * Incremental view of all open sessions for UI clients. `ack` keys are marked delivered first.
   * reset=true (no since, other server_id, or events after since were dropped) also carries each
   * session's current view so the client can rebuild from scratch.
   */
  snapshot(params: SnapshotParams): SnapshotResult {
    params.ack?.forEach(key => {
      const groups = NOTICE_KEY.exec(key)?.groups
      groups?.server === this.serverId && this.sessions.get(groups.session)?.adapter.acknowledge(groups.id)
    })
    const { since } = params
    const opens = [...this.sessions.values()]
    const reset = since === undefined || params.server_id !== this.serverId || opens.some(s => s.adapter.lostSince(since))
    const sessions: SessionSnapshot[] = opens.map(s => ({
      ...this.stateOf(s),
      ...this.progress(s.id),
      config_options: s.adapter.configs,
      notifications: s.adapter.undelivered().map(n => ({ key: `${this.serverId}:${s.id}:${n.id}`, ...n.item })),
      events: s.adapter.eventsSince(reset ? undefined : since),
      ...(reset ? { view: s.adapter.view() } : {}),
    }))
    return { server_id: this.serverId, seq: currentSeq(), reset, sessions }
  }

  // ── Helpers ──

  private get(id: string): OpenSession {
    const open = this.sessions.get(id)
    if (!open) throw new CockpitError('SESSION_NOT_FOUND', `Session not open in this server: ${id}`)
    return open
  }

  private stateOf(open: OpenSession): SessionState {
    const { adapter } = open
    return {
      session: open.id,
      state: adapter.state,
      cancelling: adapter.cancelling,
      subagent: open.subagent,
      cwd: open.cwd,
      approvals: adapter.pendingApprovals,
      questions: adapter.pendingQuestions,
      waiting: adapter.waiting,
    }
  }

  private timestamp(): string {
    return new Date(this.host.clock.now()).toISOString()
  }
}
