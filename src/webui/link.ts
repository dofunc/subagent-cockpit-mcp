import { spawn } from 'node:child_process'
import type { Host } from '../host/host'
import type { SessionActivity, SessionManager } from '../session/session-manager'
import type { McpToWebui, ConversationActivity, WebuiPingResult } from '../types'
import { WEBUI_MESSAGE_LIMIT, WEBUI_NAME, WEBUI_PROTOCOL } from './protocol'

const PROBE_TIMEOUT_MS = 1000
const SPAWN_POLL_MS = 200
const SPAWN_WAIT_MS = 5000
const RECONNECT_MS = 5000
const CLOSE_WAIT_MS = 1000

type Probe = { kind: 'webui' } | { kind: 'mismatch'; protocol: number } | { kind: 'refused' } | { kind: 'foreign' }

/**
 * Connects this MCP server to the shared webui, starting it when nothing listens on the port.
 * Runs in the background: failures are logged and never reach the MCP tools. While not connected,
 * session activity is dropped, not queued.
 */
export class WebuiLink {
  private socket?: WebSocket
  private client: { name: string; version: string } | null = null
  private stopped = false
  private announced = false
  private readonly startedAt: number

  constructor(private readonly host: Host, private readonly manager: SessionManager, private readonly port: number, private readonly version: string) {
    this.startedAt = host.clock.now()
  }

  /** Probe, start or connect in the background. Port 0 does nothing at all. */
  start(): void {
    if (this.port === 0) return
    this.manager.onActivity(activity => this.socket?.readyState === WebSocket.OPEN && this.send(this.toMessage(activity)))
    this.reconnect()
  }

  /** The MCP client's name, once `initialize` is done. */
  setClient(client: { name: string; version: string }): void {
    this.client = client
    this.send({ type: 'client', ...client })
  }

  /** Close the connection after what is already queued, waiting at most a second. */
  async stop(): Promise<void> {
    this.stopped = true
    const socket = this.socket
    if (!socket) return
    await new Promise<void>(resolve => {
      const timer = this.host.clock.setTimeout(resolve, CLOSE_WAIT_MS)
      socket.addEventListener('close', () => {
        timer.cancel()
        resolve()
      })
      socket.close()
    })
  }

  private reconnect(): void {
    this.connectOrSpawn().catch((err: Error) => this.host.log(`webui: ${err.message}`))
  }

  private async connectOrSpawn(): Promise<void> {
    if (this.stopped) return
    const probe = await this.probe()
    if (probe.kind === 'webui') return this.open()
    if (probe.kind === 'mismatch') {
      this.host.log(`webui on port ${this.port} speaks protocol ${probe.protocol}, expected ${WEBUI_PROTOCOL}; not connecting`)
      return
    }
    if (probe.kind === 'foreign') {
      this.host.log(`port ${this.port} is in use by another program; webui disabled, set webui.port to change it`)
      return
    }
    this.spawnWebui()
    if (await this.awaitWebui(this.host.clock.now() + SPAWN_WAIT_MS)) return this.open()
    this.host.log(`webui did not start on port ${this.port} within ${SPAWN_WAIT_MS / 1000}s`)
  }

  /** GET /api/ping: a refused connection means nothing listens; any other answer or failure is someone else. */
  private async probe(): Promise<Probe> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/ping`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      const ping: Partial<WebuiPingResult> = JSON.parse(await res.text())
      if (ping.name !== WEBUI_NAME) return { kind: 'foreign' }
      return ping.protocol === WEBUI_PROTOCOL ? { kind: 'webui' } : { kind: 'mismatch', protocol: Number(ping.protocol) }
    } catch (err) {
      const refused = err instanceof Error && err.cause instanceof Error && 'code' in err.cause && err.cause.code === 'ECONNREFUSED'
      return { kind: refused ? 'refused' : 'foreign' }
    }
  }

  /** Probe every 200 ms until the webui answers or the deadline passes. */
  private async awaitWebui(deadline: number): Promise<boolean> {
    await new Promise<void>(resolve => this.host.clock.setTimeout(resolve, SPAWN_POLL_MS))
    if ((await this.probe()).kind === 'webui') return true
    return this.host.clock.now() < deadline && this.awaitWebui(deadline)
  }

  /** Detached from this process group, so the webui outlives the MCP client's terminal. */
  private spawnWebui(): void {
    const child = spawn(process.execPath, [this.host.bundledPath('webui.js'), '--port', String(this.port)], { detached: true, stdio: 'ignore' })
    child.on('error', err => this.host.log(`webui: start failed: ${err.message}`))
    child.unref()
  }

  private open(): void {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/mcp`)
    this.socket = socket
    socket.addEventListener('open', () => {
      this.send({ type: 'hello', pid: process.pid, cwd: process.cwd(), version: this.version, started_at: this.startedAt })
      this.client && this.send({ type: 'client', ...this.client })
      this.manager.openedSessions().forEach(activity => this.send(this.toMessage(activity)))
      if (this.announced) return
      this.announced = true
      this.host.log(`webui: http://127.0.0.1:${this.port}`)
    })
    // A webui that went away is probed, and started again if need be, after a pause
    socket.addEventListener('close', () => {
      this.socket = undefined
      this.stopped || this.host.clock.setTimeout(() => this.reconnect(), RECONNECT_MS)
    })
  }

  private send(message: McpToWebui): void {
    // Not connected: the monitor misses it, by design
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private toMessage({ session, activity }: SessionActivity): McpToWebui {
    return { type: 'activity', session, at: this.host.clock.now(), activity: this.toConversationActivity(activity) }
  }

  /** An ACP message travels as plain JSON; one over WEBUI_MESSAGE_LIMIT bytes is replaced by a marker. */
  private toConversationActivity(activity: SessionActivity['activity']): ConversationActivity {
    if (activity.kind !== 'acp') return activity
    const { direction, message } = activity
    const text = JSON.stringify(message)
    const bytes = Buffer.byteLength(text)
    if (bytes <= WEBUI_MESSAGE_LIMIT) return { kind: 'acp', direction, message: JSON.parse(text) }
    return { kind: 'acp', direction, message: { truncated: true, bytes, method: 'method' in message ? message.method : null, id: 'id' in message ? message.id : null } }
  }
}
