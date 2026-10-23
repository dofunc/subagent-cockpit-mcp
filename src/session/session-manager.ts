import { CockpitError, createAdapter } from '../adapter/adapter'
import type { AdapterActivity, ApprovalVerb, SubagentAdapter } from '../adapter/adapter'
import { resolveSubagent } from '../config'
import type { Host, Timer } from '../host/host'
import type {
  AnswerAction, AnswerContent, AppConfig, CancelResult, CloseResult, ConfigOptionInfo, ConfigValues, DeleteResult, ConversationActivity,
  OpenParams, OpenResult, OutputResult, ProgressResult, PromptResult, SessionCloseReason, SessionSnapshotBase,
  SessionState, SessionStatus, SessionSummary, SnapshotParams, SubagentConfig, SubagentInfo,
} from '../types'
import { SessionStore } from './session-store'

/** State, feedback and notifications of the selected open sessions; the MCP layer adds their conversation. */
export interface SessionsSnapshot {
  server_id: string
  sessions: SessionSnapshotBase[]
}

/** A session this process closed for idleness: what the read tools return, and the close still finishing in the background */
interface IdleClosed {
  status: SessionStatus
  progress: ProgressResult
  output: OutputResult
  closing: Promise<void>
  withdrawn: boolean
}

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

const configValues = (configs: ConfigOptionInfo[]): ConfigValues => Object.fromEntries(configs.map(o => [o.id, o.current_value]))

/**
 * Session registry for one MCP server process. The in-memory map is the source of truth and holds
 * only sessions this process opened; other processes' sessions are visible on disk only.
 * Cross-process ownership is the lock.pid file in each session directory.
 */
export class SessionManager {
  readonly serverId = crypto.randomUUID()
  private readonly sessions = new Map<string, OpenSession>()
  /** Sessions closed for idleness, reopened by prompt and set_config until close or delete withdraws them */
  private readonly idleClosed = new Map<string, IdleClosed>()
  /** The reconnect in flight for an idle-closed session, shared by every call waiting on it */
  private readonly reviving = new Map<string, Promise<void>>()
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
   * Open a session. An explicit `session` reconnects it. `reuse` takes, in order: this process's longest-idle
   * IDLE session with the same cwd and subagent; else the latest closed one on disk, tried once; else a new
   * one. A failed reuse never fails open: it creates a new session and says why in `reuse_skipped`, and a
   * reconnect that failed after taking lock.pid marks the session so reuse skips it from then on. No task is
   * sent here; the caller gets the session id first and sends tasks with prompt().
   */
  async open(params: OpenParams, signal?: AbortSignal): Promise<OpenResult> {
    const sub = resolveSubagent(this.config, params.subagent)
    if (params.session) {
      await this.revived(params.session)
      return this.reconnect(params.session, signal)
    }
    if (!params.reuse) return this.create(params, sub, signal)
    // A session still restoring its config after an automatic reconnect is IDLE in the adapter but not ready
    const idle = [...this.sessions.values()]
      .filter(s => s.cwd === params.cwd && s.subagent === params.subagent && s.adapter.state === 'IDLE' && !s.adapter.busy && !this.reviving.has(s.id))
      .sort((a, b) => a.adapter.idleSince - b.adapter.idleSince)[0]
    if (idle) return this.opened(idle.id, true, { status: 'done' }, idle.adapter)
    const closed = await this.closedCandidate(params)
    if (!closed) return this.create(params, sub, signal)
    try {
      // A session this process closed for idleness comes back through the shared revive, as prompt brings it back
      if (this.idleClosed.has(closed)) await this.revived(closed)
      return { ...await this.reconnect(closed, signal, { markOnFailure: true }), reused: true }
    } catch (err) {
      // One attempt only: whatever went wrong with the candidate (gone, in use, broken, a file error), create a new one
      const code = err instanceof CockpitError ? err.code : 'AGENT_ERROR'
      const message = err instanceof Error ? err.message : String(err)
      this.host.log(`reuse of ${closed} skipped: ${message}`)
      return { ...await this.create(params, sub, signal), reuse_skipped: { session: closed, code, message } }
    }
  }

  /** The latest closed session on disk that reuse may try: same cwd and subagent, not marked reuse_failed, lock.pid free. */
  private async closedCandidate({ cwd, subagent }: OpenParams): Promise<string | undefined> {
    const matches = (await this.store.list()).filter(({ record }) => record.cwd === cwd && record.subagent === subagent && !record.reuse_failed)
    // list() is most recent first: check the locks in that order and stop at the first free one
    return matches.reduce<Promise<string | undefined>>(
      async (found, { id }) => (await found) ?? (await this.store.locked(id) ? undefined : id),
      Promise.resolve(undefined),
    )
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

  /**
   * Reconnect. A session already open in this process returns its current state right away. A successful
   * reconnect clears reuse_failed. With markOnFailure, a failure after taking lock.pid and before the session
   * registers marks the session reuse_failed while the lock is still held; after registration an agent exit
   * releases the lock on its own path, so nothing is written here.
   */
  private async reconnect(id: string, signal?: AbortSignal, options?: { markOnFailure?: boolean }): Promise<OpenResult> {
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
    const phase = { established: false }
    try {
      const result = await adapter.open({
        config,
        cwd: record.cwd,
        role: record.role,
        resumeId: parsed.native,
        // Records written before config was kept fall back to the subagent config
        restore: record.config && Object.entries(record.config),
        signal,
        onEstablished: async () => {
          phase.established = true
          this.register(id, adapter, record.subagent, record.cwd)
          announce(id, record.subagent, record.cwd, true)
          record.reuse_failed && await this.store.update(id, { reuse_failed: undefined })
            .catch((err: Error) => this.host.log(`clear reuse_failed of ${id} failed: ${err.message}`))
        },
      })
      return this.opened(id, false, result, adapter)
    } catch (err) {
      if (options?.markOnFailure && !phase.established && err instanceof CockpitError) {
        await this.store.update(id, { reuse_failed: { at: this.timestamp(), code: err.code } })
          .catch((e: Error) => this.host.log(`mark ${id} reuse_failed failed: ${e.message}`))
      }
      if (!phase.established) await this.store.releaseLock(id)
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
    // Persist the config for a reconnect, which would otherwise start from the agent's defaults
    adapter.onConfigChange(configs => {
      this.store.update(id, { config: configValues(configs) }).catch((err: Error) => this.host.log(`save config of ${id} failed: ${err.message}`))
    })
  }

  // ── Turns and approvals ──

  async prompt(id: string, text: string, wait: boolean, signal?: AbortSignal): Promise<PromptResult> {
    const open = await this.running(id, signal)
    const sends = open.adapter.state === 'IDLE'
    const pending = open.adapter.prompt(text, wait, { signal })
    const recorded = sends ? this.store.update(open.id, { last_prompt: text.slice(0, LAST_PROMPT_LENGTH), last_at: this.timestamp() }) : undefined
    // Subscribe to both right away so a fast failure of the turn is never an unhandled rejection
    const [result] = await Promise.all([pending, recorded])
    return result
  }

  /** An idle-closed session has nothing pending, so any approval_id is one it never issued. */
  async respond(verb: ApprovalVerb, id: string, approvalId: string, optionId: string | undefined, wait: boolean, signal?: AbortSignal): Promise<PromptResult> {
    if (this.idleOnly(id)) throw new CockpitError('INVALID_OPTION', `Unknown approval_id: ${approvalId}`)
    return this.get(id).adapter.respond(verb, approvalId, optionId, wait, { signal })
  }

  async answer(id: string, questionId: string, action: AnswerAction, content: AnswerContent | undefined, wait: boolean, signal?: AbortSignal): Promise<PromptResult> {
    if (this.idleOnly(id)) throw new CockpitError('INVALID_OPTION', `Unknown question_id: ${questionId}`)
    return this.get(id).adapter.answerQuestion(questionId, action, content, wait, { signal })
  }

  /** The agent's latest execution feedback; the main agent calls it only when it wants it. */
  progress(id: string): ProgressResult {
    const idle = this.idleOnly(id)
    if (idle) return idle.progress
    const { adapter } = this.get(id)
    return { plan: adapter.plan, usage: adapter.usage, title: adapter.title, commands: adapter.commands }
  }

  cancel(id: string): CancelResult {
    if (this.idleOnly(id)) return { status: 'done' }
    return this.get(id).adapter.cancel()
  }

  async setConfig(id: string, configId: string, value: string, signal?: AbortSignal): Promise<ConfigOptionInfo[]> {
    return (await this.running(id, signal)).adapter.setConfig(configId, value)
  }

  /** Session state with the current value of each config option; the choices are left out. Idle-closed: CLOSED with its last values. */
  status(id: string): SessionStatus {
    const idle = this.idleOnly(id)
    if (idle) return idle.status
    const open = this.get(id)
    return { ...this.stateOf(open), config: configValues(open.adapter.configs) }
  }

  output(id: string): OutputResult {
    return this.idleOnly(id)?.output ?? this.get(id).adapter.lastOutput
  }

  // ── Reopening sessions closed for idleness ──

  /** What an idle-closed session left, while it is not open again or its reconnect has not finished. */
  private idleOnly(id: string): IdleClosed | undefined {
    const idle = this.idleClosed.get(id)
    return idle && (!this.sessions.has(id) || this.reviving.has(id)) ? idle : undefined
  }

  /**
   * The open session, reopened and restored first when this process closed it for idleness. A cancelled
   * request stops waiting at once and sends nothing; the shared reconnect goes on for the other callers.
   */
  private async running(id: string, signal?: AbortSignal): Promise<OpenSession> {
    // Checked before revived(): a request cancelled on arrival starts no reconnect and leaves no promise unobserved
    if (signal?.aborted) throw new Error('Request cancelled')
    const shared = this.revived(id)
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('Request cancelled'))
      signal?.addEventListener('abort', onAbort, { once: true })
      shared.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
    })
    if (signal?.aborted) throw new Error('Request cancelled')
    return this.get(id)
  }

  /** Wait out an idle close and the reconnect after it, starting that reconnect when no one has yet. */
  private async revived(id: string): Promise<void> {
    const idle = this.idleClosed.get(id)
    const start = idle && !idle.withdrawn && !this.sessions.has(id)
    await (this.reviving.get(id) ?? (start ? this.revive(id, idle) : undefined))
  }

  private revive(id: string, idle: IdleClosed): Promise<void> {
    this.host.log(`reopening idle-closed session ${id}`)
    const gone = () => new CockpitError('SESSION_NOT_FOUND', `Session not open in this server: ${id}`)
    // The old agent exits, session_closed goes out and lock.pid is released before the new agent starts.
    // No caller's AbortSignal: one caller giving up must not abort the reconnect the others wait on
    const pending = idle.closing
      .then(() => {
        if (idle.withdrawn) throw gone()
        // Marked on failure as reuse does, so reuse does not pick a broken session again
        return this.reconnect(id, undefined, { markOnFailure: true })
      })
      .then(async () => {
        if (idle.withdrawn) {
          // close or delete came in while reopening: undo it, and the queued calls fail as on a closed session
          await this.closeSession(this.get(id), 'closed')
          throw gone()
        }
        this.idleClosed.delete(id)
      }, (err: Error) => {
        err instanceof CockpitError && err.code === 'SESSION_NOT_FOUND' && this.idleClosed.delete(id)
        throw err
      })
      .finally(() => this.reviving.delete(id))
    this.reviving.set(id, pending)
    return pending
  }

  /** Take back the right to reopen on its own; a reconnect in flight closes what it opened before this returns. */
  private async withdraw(id: string): Promise<void> {
    const idle = this.idleClosed.get(id)
    if (!idle) return
    idle.withdrawn = true
    await this.reviving.get(id)?.catch((err: Error) => this.host.log(`reopen of ${id} ended: ${err.message}`))
    await idle.closing
    this.idleClosed.delete(id)
  }

  // ── Close and delete ──

  /**
   * Close one session, or all when id is omitted, including the ones closed for idleness: those lose the right
   * to reopen on their own, and a reconnect in flight is undone before this returns. Session directories are kept.
   */
  async close(id?: string): Promise<CloseResult> {
    if (id !== undefined && !this.idleClosed.has(id)) this.get(id)
    const ids = id !== undefined ? [id] : [...new Set([...this.sessions.keys(), ...this.idleClosed.keys()])]
    await Promise.all(ids.map(i => this.withdraw(i)))
    const targets = ids.flatMap(i => this.sessions.get(i) ?? [])
    await Promise.all(targets.map(s => this.closeSession(s, 'closed')))
    return { closed: ids }
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
    await this.withdraw(id)
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
      // Also for a session closed earlier: the conversation store and the webui still hold its conversation
      this.publish({ session: id, activity: { kind: 'session_closed', reason: 'deleted' } })
      return { session: id, native }
    } catch (err) {
      // The adapter closed the open session on the way out; the directory stays for a retry
      open && this.publish({ session: id, activity: { kind: 'session_closed', reason: 'closed' } })
      await this.store.flush(id)
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
    // A session still restoring its config after an automatic reconnect is IDLE in the adapter but not ready
    const stale = [...this.sessions.values()]
      .filter(s => s.adapter.state === 'IDLE' && !s.adapter.busy && !s.adapter.waiting && !this.reviving.has(s.id) && now - s.adapter.idleSince >= limit)
    stale.forEach(s => {
      this.host.log(`closing idle session ${s.id}`)
      // Read before closeSession drops the session from the map; prompt and set_config reopen it later
      const status: SessionStatus = { ...this.status(s.id), state: 'CLOSED' }
      const [progress, output] = [this.progress(s.id), this.output(s.id)]
      const closing = this.closeSession(s, 'idle').catch((err: Error) => this.host.log(`close ${s.id} failed: ${err.message}`))
      this.idleClosed.set(s.id, { status, progress, output, closing, withdrawn: false })
    })
  }

  // ── Snapshot ──

  /**
   * State, feedback and notifications of the open sessions, or of `session` alone (SESSION_NOT_FOUND when it is
   * not open here). `ack` keys are marked delivered first. The MCP layer adds the conversation items and decides reset.
   */
  snapshot(params: SnapshotParams): SessionsSnapshot {
    params.ack?.forEach(key => {
      const groups = NOTICE_KEY.exec(key)?.groups
      groups?.server === this.serverId && this.sessions.get(groups.session)?.adapter.acknowledge(groups.id)
    })
    const opens = params.session === undefined ? [...this.sessions.values()] : [this.get(params.session)]
    const sessions = opens.map(s => ({
      ...this.stateOf(s),
      ...this.progress(s.id),
      config_options: s.adapter.configs,
      notifications: s.adapter.undelivered().map(n => ({ key: `${this.serverId}:${s.id}:${n.id}`, ...n.item })),
    }))
    return { server_id: this.serverId, sessions }
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
