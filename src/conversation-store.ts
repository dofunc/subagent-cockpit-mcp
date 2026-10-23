import type { Host } from './host/host'
import type { SessionActivity, SessionManager } from './session/session-manager'
import type { AppConfig, Conversation, SnapshotItem } from './types'
import { applyActivity, createConversation } from './webui/transcript'
import { truncateActivity } from './webui/truncate'

/**
 * Each session's conversation as the webui shows it, merged by the same code, with a revision per item for
 * `snapshot`. MCP layer: it listens to SessionManager as WebuiLink does. Revisions count up across sessions.
 * A closed session keeps its conversation, as the webui does, and a reconnect with the same id goes on with it;
 * only a deleted session lets it go.
 */
export class ConversationStore {
  private readonly views = new Map<string, Conversation>()
  /** Session -> item id -> revision of its last change */
  private readonly revisions = new Map<string, Map<string, number>>()
  /** Session -> revision at which the retention limit last removed items */
  private readonly removedRev = new Map<string, number>()
  private rev = 0
  private readonly serverId: string

  constructor(manager: SessionManager, private readonly limits: AppConfig['snapshot'], private readonly host: Host) {
    this.serverId = manager.serverId
    manager.openedSessions().forEach(activity => this.apply(activity))
    manager.onActivity(activity => this.apply(activity))
  }

  /** The latest revision; a client passes it back as `since`. */
  get seq(): number {
    return this.rev
  }

  /** Whether the retention limit dropped items of the session after since: the caller resets every selected session then. */
  lostSince(session: string, since: number): boolean {
    return (this.removedRev.get(session) ?? 0) > since
  }

  /** Items of one session changed after since, or all of them when since is undefined; type and last filters are the caller's. */
  items(session: string, since: number | undefined): SnapshotItem[] {
    const view = this.views.get(session)
    const revs = this.revisions.get(session)
    if (!view || !revs) return []
    return view.items
      .map(({ log: _log, ...item }) => ({ ...item, rev: revs.get(item.id) ?? 0 }))
      .filter(item => since === undefined || item.rev > since)
  }

  private apply({ session, activity }: SessionActivity): void {
    if (activity.kind === 'session_closed' && activity.reason === 'deleted') {
      this.views.delete(session)
      this.revisions.delete(session)
      this.removedRev.delete(session)
      return
    }
    const existing = this.views.get(session)
    const view = existing ?? (activity.kind === 'session_opened' ? createConversation(this.serverId, session, activity, this.limits.max_message_count) : undefined)
    // Activity of a session never seen open has nothing to attach to, as in the webui
    if (!view) return
    const revs = this.revisions.get(session) ?? new Map<string, number>()
    this.views.set(session, view)
    this.revisions.set(session, revs)
    applyActivity(view, this.host.clock.now(), truncateActivity(activity, this.limits.truncate_message_size))
    const rev = ++this.rev
    view.changes.touched.forEach(id => revs.set(id, rev))
    view.changes.removed.forEach(id => revs.delete(id))
    view.changes.removed.length > 0 && this.removedRev.set(session, rev)
    // A reconnect with the same id: every kept item comes again, for a client that dropped the session while it was closed
    existing && activity.kind === 'session_opened' && view.items.forEach(item => revs.set(item.id, rev))
  }
}
