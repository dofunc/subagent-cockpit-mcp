import type { Host } from '../host/host'
import type { ConfigValues, ErrorCode } from '../types'

export interface SessionRecord {
  subagent: string
  cwd: string
  role: string
  created_at: string
  last_prompt: string
  last_at: string
  /** Title the agent gave the session; absent in records written before titles were kept */
  title?: string
  /** Current value of each config option, as the session last had them; absent in records written before config was kept */
  config?: ConfigValues
  /** A reconnect by reuse failed after taking lock.pid; reuse skips the session until a reconnect succeeds */
  reuse_failed?: { at: string; code: ErrorCode }
}

export interface StoredSession {
  id: string
  record: SessionRecord
}

const SESSION_ID = /^(?<adapter>[^_]+)_(?<native>.+)$/
// An empty lock.pid is read again this many times, this far apart, before it counts as abandoned
const LOCK_REREADS = 3
const LOCK_REREAD_MS = 50

/**
 * Session directories under <home>/sessions/<id>/, holding session.json and lock.pid.
 * The directory name is the session id: <adapter>_<native session id>.
 */
export class SessionStore {
  private readonly root: string
  // Tail of each session's update chain; every read-modify-write of one session.json runs after the earlier ones
  private readonly writes = new Map<string, Promise<void>>()

  constructor(private readonly host: Host, home: string) {
    this.root = host.store.join(home, 'sessions')
  }

  static sessionId(adapter: string, nativeId: string): string {
    return `${adapter}_${nativeId}`
  }

  /** Split a session id into adapter name and native session id. Returns null when malformed. */
  static parseId(id: string): { adapter: string; native: string } | null {
    const groups = SESSION_ID.exec(id)?.groups
    return groups ? { adapter: groups.adapter, native: groups.native } : null
  }

  private dir(id: string): string {
    return this.host.store.join(this.root, id)
  }

  private lockPath(id: string): string {
    return this.host.store.join(this.dir(id), 'lock.pid')
  }

  exists(id: string): Promise<boolean> {
    return this.host.store.exists(this.host.store.join(this.dir(id), 'session.json'))
  }

  async create(id: string, record: SessionRecord): Promise<void> {
    await this.host.store.mkdir(this.dir(id))
    await this.write(id, record)
  }

  async read(id: string): Promise<SessionRecord> {
    return JSON.parse(await this.host.store.readText(this.host.store.join(this.dir(id), 'session.json')))
  }

  /** Merge patch into session.json. Updates of one session run one after another, in call order. */
  update(id: string, patch: Partial<SessionRecord>): Promise<void> {
    const run = this.flush(id).then(async () => this.write(id, { ...await this.read(id), ...patch }))
    this.writes.set(id, run)
    // The caller gets the failure through run; the chain only needs to know it finished
    run.catch(() => undefined).finally(() => this.writes.get(id) === run && this.writes.delete(id))
    return run
  }

  /** Resolves once every update queued so far for this session has finished, failed ones included. */
  flush(id: string): Promise<void> {
    return (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined)
  }

  /** Write session.json through a temp file and an atomic rename, so readers never see a partial file. */
  private async write(id: string, record: SessionRecord): Promise<void> {
    const target = this.host.store.join(this.dir(id), 'session.json')
    const temp = `${target}.${this.host.env.pid}.tmp`
    await this.host.store.writeText(temp, `${JSON.stringify(record, null, 2)}\n`)
    await this.host.store.rename(temp, target)
  }

  private async lockOwner(id: string): Promise<number | null> {
    const text = await this.host.store.readText(this.lockPath(id)).catch(() => '')
    const pid = Number.parseInt(text, 10)
    return Number.isNaN(pid) ? null : pid
  }

  /**
   * Owner of an existing lock.pid. Creating the file and writing the pid are two steps, so an empty
   * file usually means another process is about to write; it is read again a few times before it
   * counts as abandoned (null).
   */
  private async settledLockOwner(id: string): Promise<number | null> {
    const wait = () => new Promise<void>(resolve => this.host.clock.setTimeout(resolve, LOCK_REREAD_MS))
    return Array.from({ length: LOCK_REREADS }).reduce<Promise<number | null>>(async prev => {
      const owner = await prev
      if (owner !== null) return owner
      await wait()
      return this.lockOwner(id)
    }, this.lockOwner(id))
  }

  /**
   * Take lock.pid for this process. Fails (false) when a live process holds it.
   * A lock left by a dead process, or left empty, is removed and created exclusively again,
   * so only one of the processes taking it over at the same time wins.
   */
  async acquireLock(id: string): Promise<boolean> {
    const own = this.host.env.pid
    const path = this.lockPath(id)
    if (await this.host.store.createExclusive(path, String(own))) return true
    const owner = await this.settledLockOwner(id)
    if (owner === own) return true
    if (owner !== null && this.host.env.isAlive(owner)) return false
    await this.host.store.remove(path)
    return this.host.store.createExclusive(path, String(own))
  }

  /** Delete lock.pid only when it still names this process. */
  async releaseLock(id: string): Promise<void> {
    if (await this.lockOwner(id) === this.host.env.pid) await this.host.store.remove(this.lockPath(id))
  }

  /** True when lock.pid names a live process, this one included. */
  async locked(id: string): Promise<boolean> {
    const owner = await this.lockOwner(id)
    return owner !== null && this.host.env.isAlive(owner)
  }

  /** True when lock.pid names a live process other than this one. */
  async lockedByOther(id: string): Promise<boolean> {
    const owner = await this.lockOwner(id)
    return owner !== null && owner !== this.host.env.pid && this.host.env.isAlive(owner)
  }

  /** All sessions, most recent activity first (last_at, falling back to created_at). */
  async list(): Promise<StoredSession[]> {
    if (!await this.host.store.exists(this.root)) return []
    const ids = await this.host.store.list(this.root)
    const sessions = await Promise.all(ids.map(async id => {
      const record = await this.read(id).catch((err: Error) => {
        this.host.log(`skip session ${id}: ${err.message}`)
        return null
      })
      return record ? { id, record } : null
    }))
    const recency = (s: StoredSession) => s.record.last_at || s.record.created_at
    return sessions
      .filter((s): s is StoredSession => s !== null)
      .sort((a, b) => recency(b).localeCompare(recency(a)))
  }

  /** Delete the session directory once pending updates have finished. */
  async remove(id: string): Promise<void> {
    await this.flush(id)
    await this.host.store.remove(this.dir(id))
  }
}
