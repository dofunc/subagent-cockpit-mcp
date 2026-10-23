import { Command, Option } from 'commander'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import './adapter/codex-adapter'
import './adapter/claude-adapter'
import './adapter/grok-adapter'
import './adapter/opencode-adapter'
import './adapter/antigravity-adapter'
import { loadConfig, resolveHome } from './config'
import { ConversationStore } from './conversation-store'
import type { Host } from './host/host'
import { NodeHost } from './host/node-host'
import { createServer } from './server'
import { SessionManager } from './session/session-manager'
import type { AppConfig } from './types'
import { WebuiLink } from './webui/link'

declare const __VERSION__: string

// __VERSION__ is injected by webpack; running from source (tests) has no build step
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'

/**
 * Port of the shared webui: SUBAGENT_COCKPIT_WEBUI_PORT, else webui.port. 0 turns the webui off;
 * anything other than an integer from 0 to 65535 turns it off with a note on stderr.
 */
function webuiPort(host: Host, config: AppConfig): number {
  const raw = host.env.get('SUBAGENT_COCKPIT_WEBUI_PORT') || String(config.webui.port)
  const port = Number(raw)
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port
  host.log(`webui: invalid port ${raw}; webui disabled`)
  return 0
}

/** Run the MCP server over stdio. stdout carries protocol messages only; logs go to stderr. */
async function runMcp(): Promise<void> {
  const host = new NodeHost()
  const home = resolveHome(host)
  const config = await loadConfig(host, home)
  const manager = new SessionManager(host, config, home)
  const store = new ConversationStore(manager, config.snapshot, host)
  const server = createServer(manager, store, VERSION)
  const link = new WebuiLink(host, manager, webuiPort(host, config), VERSION, config.webui)
  server.oninitialized = () => {
    const client = server.getClientVersion()
    client && link.setClient({ name: client.name, version: client.version })
  }
  const exit = { started: false }
  const shutdown = () => {
    if (exit.started) return
    exit.started = true
    // The webui hears every session_closed before the connection goes
    manager.shutdown()
      .catch((err: Error) => host.log(`shutdown failed: ${err.message}`))
      .then(() => link.stop())
      .finally(() => process.exit(0))
  }
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  await server.connect(new StdioServerTransport())
  link.start()
}

const program = new Command()
  .name('subagent-cockpit-mcp')
  .version(VERSION)
  .description('MCP server that delegates tasks to external coding agents over ACP')

program
  .command('mcp', { isDefault: true })
  .description('Run the MCP server (default command)')
  .addOption(new Option('--transport <type>', 'Transport').choices(['stdio']).default('stdio'))
  .action(runMcp)

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`subagent-cockpit-mcp: ${err.message}\n`)
  process.exit(1)
})
