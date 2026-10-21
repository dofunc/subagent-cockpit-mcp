import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { McpInfo, McpToWebui, Conversation, ConversationStreamEvents, WebuiPingResult } from '../types'
import { WEBUI_NAME, WEBUI_PROTOCOL } from './protocol'
import { applyActivity, createConversation } from './transcript'

declare const __VERSION__: string

// __VERSION__ is injected by webpack; running from source (tests) has no build step
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'
// The page built by the web config, next to dist/webui.js
const HTML_DIR = fileURLToPath(new URL('html/', import.meta.url))
const DEFAULT_GRACE_MS = 10_000

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

/**
 * The webui process: keeps every MCP server's sessions in memory and serves the read-only page.
 * MCP servers connect over WebSocket /mcp, browsers subscribe to SSE /api/stream. With no MCP
 * connection for the grace period, the process exits and everything it held is gone.
 */
class WebuiServer {
  private readonly mcps = new Map<string, McpInfo>()
  /** Keyed by mcp_id and session id: the same session reopened by another MCP server is another entry */
  private readonly sessions = new Map<string, Conversation>()
  private readonly streams = new Set<ServerResponse>()
  private readonly sockets = new Set<WebSocket>()
  private readonly hosts: string[]
  private exitTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly port: number, private readonly graceMs: number) {
    this.hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  }

  /** Listen on 127.0.0.1; EADDRINUSE means another webui won the race, so exit quietly. */
  start(): void {
    const server = createServer((req, res) => {
      this.route(req, res).catch((err: Error) => {
        process.stderr.write(`webui: ${req.url} failed: ${err.message}\n`)
        res.headersSent || this.reply(res, 500, 'Internal error')
      })
    })
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      // Browsers always send Origin on a WebSocket and Node's client never does, so no web page can pose as an MCP server
      if (this.pathOf(req) !== '/mcp' || !this.trusted(req) || req.headers.origin !== undefined) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, ws => this.onMcp(ws))
    })
    server.on('error', (err: Error) => {
      if ('code' in err && err.code === 'EADDRINUSE') process.exit(0)
      process.stderr.write(`webui: ${err.message}\n`)
      process.exit(1)
    })
    server.listen(this.port, '127.0.0.1', () => this.scheduleExit())
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A DNS-rebound name resolving to 127.0.0.1 still carries its own Host
    if (!this.trusted(req)) return this.reply(res, 403, 'Forbidden')
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.reply(res, 405, 'Method not allowed')
    const path = this.pathOf(req)
    if (path === '/api/ping') {
      const ping: WebuiPingResult = { name: WEBUI_NAME, protocol: WEBUI_PROTOCOL, pid: process.pid, version: VERSION }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ping))
      return
    }
    if (path === '/api/stream') return this.subscribe(req, res)
    return this.serveFile(path, res)
  }

  /** A file under dist/html/, index.html for `/`; a path that climbs out of it is not found. */
  private async serveFile(path: string, res: ServerResponse): Promise<void> {
    const file = normalize(join(HTML_DIR, decodeURIComponent(path === '/' ? '/index.html' : path)))
    if (!file.startsWith(HTML_DIR)) return this.reply(res, 404, 'Not found')
    const body = await readFile(file).catch(() => null)
    if (!body) return this.reply(res, 404, 'Not found')
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  }

  /** SSE: everything held so far as `init`, then each change as it happens. */
  private subscribe(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(this.frame('init', { mcps: [...this.mcps.values()], sessions: [...this.sessions.values()] }))
    this.streams.add(res)
    req.on('close', () => this.streams.delete(res))
  }

  private onMcp(socket: WebSocket): void {
    const mcpId = randomUUID()
    this.sockets.add(socket)
    clearTimeout(this.exitTimer)
    socket.on('message', data => {
      try {
        this.onMessage(mcpId, JSON.parse(data.toString()))
      } catch (err) {
        process.stderr.write(`webui: bad message from ${mcpId}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    })
    socket.on('error', err => process.stderr.write(`webui: connection ${mcpId}: ${err.message}\n`))
    socket.on('close', () => {
      this.sockets.delete(socket)
      const mcp = this.mcps.get(mcpId)
      if (mcp) {
        mcp.connected = false
        this.broadcast('mcp_disconnected', { mcp_id: mcpId })
      }
      this.scheduleExit()
    })
  }

  private onMessage(mcpId: string, message: McpToWebui): void {
    switch (message.type) {
      case 'hello': {
        const { pid, cwd, version, started_at } = message
        const info: McpInfo = { mcp_id: mcpId, pid, cwd, version, started_at, client: null, connected: true }
        this.mcps.set(mcpId, info)
        this.broadcast('mcp_connected', info)
        return
      }
      case 'client': {
        const info = this.mcps.get(mcpId)
        if (!info) return
        info.client = { name: message.name, version: message.version }
        this.broadcast('mcp_updated', info)
        return
      }
      case 'activity': {
        const { session, at, activity } = message
        const key = `${mcpId}\n${session}`
        // Activity of a session this webui never saw open has nothing to attach to
        const view = this.sessions.get(key) ?? (activity.kind === 'session_opened' ? createConversation(mcpId, session, activity) : undefined)
        if (!view) return
        this.sessions.set(key, view)
        applyActivity(view, at, activity)
        this.broadcast('activity', { mcp_id: mcpId, session, at, activity })
      }
    }
  }

  private broadcast<K extends keyof ConversationStreamEvents>(event: K, data: ConversationStreamEvents[K]): void {
    const frame = this.frame(event, data)
    this.streams.forEach(res => res.write(frame))
  }

  private frame<K extends keyof ConversationStreamEvents>(event: K, data: ConversationStreamEvents[K]): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }

  /** With no MCP connection left, exit after the grace period unless one connects in time. */
  private scheduleExit(): void {
    clearTimeout(this.exitTimer)
    if (this.sockets.size > 0) return
    this.exitTimer = setTimeout(() => process.exit(0), this.graceMs)
  }

  private trusted(req: IncomingMessage): boolean {
    return this.hosts.includes(req.headers.host ?? '')
  }

  private pathOf(req: IncomingMessage): string {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  }

  private reply(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(text)
  }
}

const { values } = parseArgs({ options: { port: { type: 'string' }, 'grace-ms': { type: 'string' } } })
const port = Number(values.port)
const graceMs = Number(values['grace-ms'] ?? DEFAULT_GRACE_MS)
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(graceMs) || graceMs < 0) {
  process.stderr.write('usage: webui.js --port <1-65535> [--grace-ms <ms>]\n')
  process.exit(1)
}
new WebuiServer(port, graceMs).start()
