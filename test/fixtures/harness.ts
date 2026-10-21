// Test harness: registers the scripted agent as the `codex` and `claude` adapters, keeps the real `grok` and
// `opencode` adapters behind fake programs, runs the agy bridge from source over a fake agy for `antigravity`,
// and builds isolated homes.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { registerAdapter } from '../../src/adapter/adapter'
import type { CommandSpec } from '../../src/adapter/adapter'
import { AntigravityAdapter } from '../../src/adapter/antigravity-adapter'
import { ClaudeAdapter } from '../../src/adapter/claude-adapter'
import { CodexAdapter } from '../../src/adapter/codex-adapter'
import '../../src/adapter/grok-adapter'
import '../../src/adapter/opencode-adapter'
import type { Store } from '../../src/host/host'
import { NodeHost } from '../../src/host/node-host'
import { SessionManager } from '../../src/session/session-manager'
import type { SessionActivity } from '../../src/session/session-manager'
import type { AppConfig, NativeDeleteResult, ProfileConfig, SubagentConfig } from '../../src/types'
import type { FakeAgyScript } from './fake-agy'
import type { Script } from './scripted-acp-agent'

export const FIXTURE = fileURLToPath(new URL('./scripted-acp-agent.ts', import.meta.url))
export const FAKE_AGY = fileURLToPath(new URL('./fake-agy.ts', import.meta.url))
const BRIDGE_SOURCE = fileURLToPath(new URL('../../src/bridge/agy-acp.ts', import.meta.url))
export const TSX = import.meta.resolve('tsx')
export const HARNESS = fileURLToPath(import.meta.url)

const fixtureCommand = (env: Record<string, string>): CommandSpec => ({ command: process.execPath, args: ['--import', TSX, FIXTURE], env })

/**
 * CodexAdapter (env rules, auth message, program lookup) that launches the scripted agent instead.
 * The scripted agent really deletes sessions, so it reports `deleted` like the base class.
 */
export class FixtureAdapter extends CodexAdapter {
  protected getCommand(_config: SubagentConfig, env: Record<string, string>): CommandSpec {
    return fixtureCommand(env)
  }

  protected nativeDeleteResult(): NativeDeleteResult {
    return 'deleted'
  }
}

/** ClaudeAdapter (initial config, args meta, allow rule) that launches the scripted agent instead. */
export class ClaudeFixtureAdapter extends ClaudeAdapter {
  protected getCommand(_config: SubagentConfig, env: Record<string, string>): CommandSpec {
    return fixtureCommand(env)
  }
}

/** AntigravityAdapter running the bridge from source; AGY_PATH points at the fake agy program. */
export class AntigravitySourceAdapter extends AntigravityAdapter {
  protected getCommand(config: SubagentConfig, env: Record<string, string>): CommandSpec {
    return { command: process.execPath, args: ['--import', TSX, BRIDGE_SOURCE, ...config.args], env }
  }
}

registerAdapter('codex', FixtureAdapter)
registerAdapter('claude', ClaudeFixtureAdapter)
registerAdapter('antigravity', AntigravitySourceAdapter)

/** Version line each fake local program prints for `--version`. */
export const FAKE_VERSIONS = {
  codex: 'codex-cli 0.162.1',
  claude: '2.1.292 (Claude Code)',
  grok: 'grok 1.0.46 (fixture)',
  opencode: 'opencode v2.0.30',
  antigravity: '1.4.2',
}

/** Adapters whose agent program speaks ACP itself; their fake program runs the scripted agent with the real argv. */
const NATIVE_ACP = new Set(['grok', 'opencode'])

/** Write an executable shell script that answers `--version` with the given line. */
export async function fakeProgram(path: string, versionLine: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\necho "${versionLine}"\n`)
  await chmod(path, 0o755)
  return path
}

/**
 * Fake grok or opencode: answers --version like the program, otherwise runs the scripted agent with the same argv,
 * so the adapter's real command line reaches the agent and is logged there.
 */
export async function fakeAcpProgram(path: string, versionLine: string): Promise<string> {
  await writeFile(path, [
    '#!/bin/sh',
    `[ "$1" = "--version" ] && { echo "${versionLine}"; exit 0; }`,
    `exec "${process.execPath}" --import "${TSX}" "${FIXTURE}" "$@"`,
  ].join('\n'))
  await chmod(path, 0o755)
  return path
}

/** Fake agy: `--version` answers like agy, everything else runs fake-agy.ts with the same argv. */
export async function fakeAgyProgram(path: string): Promise<string> {
  await writeFile(path, [
    '#!/bin/sh',
    `[ "$1" = "--version" ] && { echo "${FAKE_VERSIONS.antigravity}"; exit 0; }`,
    `exec "${process.execPath}" --import "${TSX}" "${FAKE_AGY}" "$@"`,
  ].join('\n'))
  await chmod(path, 0o755)
  return path
}

export interface LogEntry {
  pid: number
  event: string
  [key: string]: unknown
}

export interface Harness {
  dir: string
  home: string
  logPath: string
  host: NodeHost
  config: AppConfig
  manager: SessionManager
  scriptPath(name: string): string
  setScript(name: string, script: Script): Promise<void>
  /** Replace the fake agy script; processes started afterwards read the new one */
  setAgy(script: FakeAgyScript): Promise<void>
  log(): Promise<LogEntry[]>
  events(name: string): Promise<LogEntry[]>
  cleanup(): Promise<void>
}

export interface HarnessOptions {
  scripts?: Record<string, Script>
  idle?: AppConfig['idle']
  /**
   * Adapter of every scripted subagent (default codex). grok and opencode run the real adapter with a fake program,
   * antigravity runs the bridge from source over the fake agy.
   */
  adapter?: 'codex' | 'claude' | 'grok' | 'opencode' | 'antigravity'
  /** Fake agy script for the antigravity adapter (default { turns: [] }) */
  agy?: FakeAgyScript
  subagent?: Partial<SubagentConfig>
  env?: Record<string, Record<string, string>>
  profiles?: Record<string, ProfileConfig>
}

/** Subagent config pointing at a script file, the shared log and a fake local program. */
export function subagentFor(scriptPath: string, logPath: string, extra: Partial<SubagentConfig> = {}, env: Record<string, string> = {}): Partial<SubagentConfig> {
  return {
    adapter: 'codex',
    ...extra,
    env: { SCRIPTED_ACP: scriptPath, SCRIPTED_ACP_LOG: logPath, ...env },
  }
}

export async function setup(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-test-'))
  const home = join(dir, 'home')
  const logPath = join(dir, 'agent.log')
  const adapter = opts.adapter ?? 'codex'
  const fakePath = join(dir, `fake-${adapter}`)
  const program = adapter === 'antigravity'
    ? await fakeAgyProgram(fakePath)
    : NATIVE_ACP.has(adapter)
      ? await fakeAcpProgram(fakePath, FAKE_VERSIONS[adapter])
      : await fakeProgram(fakePath, FAKE_VERSIONS[adapter])
  const scripts = opts.scripts ?? { agent: {} }
  const scriptPath = (name: string) => join(dir, `${name}.script.json`)
  const agyPath = join(dir, 'agy.script.json')
  await Promise.all(Object.entries(scripts).map(([name, s]) => writeFile(scriptPath(name), JSON.stringify(s))))
  await writeFile(agyPath, JSON.stringify(opts.agy ?? { turns: [] }))
  const agyEnv = adapter === 'antigravity' ? { FAKE_AGY_SCRIPT: agyPath, FAKE_AGY_LOG: logPath } : {}
  const config: AppConfig = {
    idle: opts.idle ?? { timeout: 0 },
    // Second guard after SUBAGENT_COCKPIT_WEBUI_PORT=0: tests never reach the user's webui
    webui: { port: 0 },
    profiles: opts.profiles ?? {},
    subagents: Object.fromEntries(Object.keys(scripts).map(name => [
      name,
      subagentFor(scriptPath(name), logPath, { adapter, path: program, ...opts.subagent }, { ...agyEnv, ...opts.env?.[name] }),
    ])),
  }
  // Written for child MCP server processes that share this home
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'config.json'), JSON.stringify(config))
  const host = new NodeHost()
  const manager = new SessionManager(host, config, home)
  const log = async () => {
    const text = await readFile(logPath, 'utf-8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  }
  return {
    dir,
    home,
    logPath,
    host,
    config,
    manager,
    scriptPath,
    setScript: (name, s) => writeFile(scriptPath(name), JSON.stringify(s)),
    setAgy: s => writeFile(agyPath, JSON.stringify(s)),
    log,
    events: async event => (await log()).filter(e => e.event === event),
    async cleanup() {
      await manager.shutdown()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export type Activity = SessionActivity['activity']

/** Every session activity from now on, in order, as plain JSON (listeners get the SDK's live objects). */
export function recordActivity(manager: SessionManager): SessionActivity[] {
  const seen: SessionActivity[] = []
  manager.onActivity(activity => seen.push(JSON.parse(JSON.stringify(activity))))
  return seen
}

/** The recorded activities of one kind, in order. */
export function ofKind<K extends Activity['kind']>(seen: SessionActivity[], kind: K): Extract<Activity, { kind: K }>[] {
  return seen.map(s => s.activity).filter((a): a is Extract<Activity, { kind: K }> => a.kind === kind)
}

export const CLI_SOURCE = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

export interface ToolReply {
  isError: boolean
  data: Record<string, unknown>
}

export interface ServerProcess {
  client: Client
  transport: StdioClientTransport
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>
  close(): Promise<void>
}

/** Parse the JSON text content of a tool result (equal to structuredContent on success). */
export function parseReply(result: Awaited<ReturnType<Client['callTool']>>): ToolReply {
  const content = Array.isArray(result.content) ? result.content : []
  const first = content[0]
  const text = first && first.type === 'text' ? first.text : '{}'
  return { isError: result.isError === true, data: JSON.parse(text) }
}

/** Start another MCP server process from source (scripted agent registered) on the same home. */
export async function spawnServer(home: string): Promise<ServerProcess> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX, '--import', HARNESS, CLI_SOURCE],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), SUBAGENT_COCKPIT_HOME: home, SUBAGENT_COCKPIT_WEBUI_PORT: '0' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(transport)
  return {
    client,
    transport,
    call: async (name, args = {}) => parseReply(await client.callTool({ name, arguments: args })),
    close: () => client.close(),
  }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * NodeHost whose file writes each take `ms`, so session.json updates overlap. Finished renames and
 * removals are recorded in order as `rename:<to>` and `remove:<path>`.
 */
export class SlowWriteHost extends NodeHost {
  readonly ops: string[] = []
  readonly store: Store

  constructor(ms: number) {
    super()
    const base = new NodeHost().store
    this.store = {
      ...base,
      writeText: async (path, data) => {
        await sleep(ms)
        await base.writeText(path, data)
      },
      rename: async (from, to) => {
        await base.rename(from, to)
        this.ops.push(`rename:${to}`)
      },
      remove: async path => {
        await base.remove(path)
        this.ops.push(`remove:${path}`)
      },
    }
  }
}

/** Poll until the predicate holds, failing after the timeout. */
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(25)
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
