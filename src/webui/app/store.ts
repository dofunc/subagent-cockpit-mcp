import type { McpInfo, Conversation, ConversationStreamEvents } from '../../types'
import { applyActivity, createConversation } from '../transcript'

type Listener = () => void

/**
 * MCP servers and sessions as the webui process holds them. Sessions are mutated in place by the
 * shared reducer; `version` changes on every update so React re-reads the store.
 */
export class ConversationStore {
  mcps: McpInfo[] = []
  sessions: Conversation[] = []
  version = 0
  private listeners = new Set<Listener>()
  private frame: number | null = null
  /** The webui's message limit, for sessions opened after `init` */
  private maxMessages = 0

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  reset({ mcps, sessions, max_messages }: ConversationStreamEvents['init']): void {
    this.mcps = mcps
    this.sessions = sessions.map(session => ({ ...session, changes: { touched: [], removed: [] } }))
    this.maxMessages = max_messages
    this.changed()
  }

  upsertMcp(info: McpInfo): void {
    const known = this.mcps.some(m => m.mcp_id === info.mcp_id)
    this.mcps = known ? this.mcps.map(m => (m.mcp_id === info.mcp_id ? info : m)) : [...this.mcps, info]
    this.changed()
  }

  disconnectMcp({ mcp_id }: ConversationStreamEvents['mcp_disconnected']): void {
    this.mcps = this.mcps.map(m => (m.mcp_id === mcp_id ? { ...m, connected: false } : m))
    this.changed()
  }

  /** Activities of a session that never opened here are dropped, as the webui process does. */
  apply({ mcp_id, session, at, activity }: ConversationStreamEvents['activity']): void {
    const existing = this.sessions.find(s => s.mcp_id === mcp_id && s.session === session)
    const view = existing ?? (activity.kind === 'session_opened' ? createConversation(mcp_id, session, activity, this.maxMessages) : null)
    if (!view) return
    !existing && this.sessions.push(view)
    applyActivity(view, at, activity)
    this.changed()
  }

  /** Bursts of activity re-render once per animation frame. */
  private changed(): void {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null
      this.version++
      this.listeners.forEach(listener => listener())
    })
  }
}

/** Follow the webui's SSE stream; EventSource reconnects by itself and each reconnect starts with `init`. */
export function connect(store: ConversationStore): void {
  const source = new EventSource('api/stream')
  const on = <K extends keyof ConversationStreamEvents>(name: K, handle: (data: ConversationStreamEvents[K]) => void) =>
    source.addEventListener(name, event => handle(JSON.parse(event.data)))
  on('init', data => store.reset(data))
  on('mcp_connected', data => store.upsertMcp(data))
  on('mcp_updated', data => store.upsertMcp(data))
  on('mcp_disconnected', data => store.disconnectMcp(data))
  on('activity', data => store.apply(data))
}
