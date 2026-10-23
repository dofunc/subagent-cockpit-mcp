// Shared pieces of the e2e suites: the built server over a real MCP client, and Codex CLI as a client.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { SnapshotItem, SnapshotResult } from '../../src/types'
import { parseReply } from './harness'
import type { ToolReply } from './harness'

/** One session's conversation items, as snapshot returns them. */
export async function snapshotItems(server: Server, session: string): Promise<SnapshotItem[]> {
  const result: SnapshotResult = JSON.parse(JSON.stringify((await server.call('snapshot', { session })).data))
  return result.sessions[0]?.items ?? []
}

/** Joined text of an item's content blocks. */
export const itemText = (item: SnapshotItem): string => (Array.isArray(item.data.content) ? item.data.content : [])
  .map(block => (block && typeof block === 'object' && !Array.isArray(block) && typeof block.text === 'string' ? block.text : ''))
  .join('')

/** The history a reconnect replayed: messages outside any turn. */
export const replayed = (items: SnapshotItem[]): SnapshotItem[] => items.filter(item => (item.kind === 'message' || item.kind === 'user_message') && item.turn_id === null)

export const DIST_CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
export const TURN_TIMEOUT = 600_000

export const exists = (path: string) => access(path).then(() => true, () => false)
export const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

export interface Server {
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>
  pid: number | null
  /** What the server wrote to stderr so far */
  stderr(): string
  close(): Promise<void>
}

/**
 * Start dist/cli.js on the given cockpit home and connect a real MCP client. The webui stays off unless a port is
 * given; a string is passed to SUBAGENT_COCKPIT_WEBUI_PORT as is, for invalid values.
 */
export async function startServer(home: string, webuiPort: number | string = 0): Promise<Server> {
  const env = { ...baseEnv(), SUBAGENT_COCKPIT_HOME: home, SUBAGENT_COCKPIT_WEBUI_PORT: String(webuiPort) }
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_CLI], env, stderr: 'pipe' })
  const err = { text: '' }
  transport.stderr?.on('data', (c: Buffer) => { err.text += c.toString() })
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(transport)
  return {
    call: async (name, args = {}) => parseReply(await client.callTool({ name, arguments: args }, undefined, { timeout: TURN_TIMEOUT })),
    get pid() { return transport.pid },
    stderr: () => err.text,
    close: () => client.close(),
  }
}

/** Open a new session and return the reply (session id, status, config_options). */
export async function openSession(server: Server, cwd: string, subagent: string): Promise<ToolReply> {
  const opened = await server.call('open', { subagent, cwd })
  assert.equal(opened.isError, false, JSON.stringify(opened.data))
  return opened
}

export const promptIn = (server: Server, session: string, text: string) => server.call('prompt', { session, text })

export const approvalId = (reply: ToolReply) => String((reply.data.approval as { approval_id: string }).approval_id)

/** Asks the agent to put a question through its own question tool. */
export const COLOR_PROMPT = 'Before anything else, ask me which color I prefer, red or blue, using your tool for asking the user a question (not plain text). After I answer, reply with exactly COLOR=<my answer>.'

interface ChoiceField {
  type?: string
  oneOf?: Array<{ const: string }>
  enum?: string[]
}

/**
 * Answer for a question_needed reply: the first option of the form's first single-select field.
 * Field names differ per agent, so they are read from requested_schema, never hard-coded.
 * `word` matches the option in a reply: the value without a trailing note such as "(Recommended)",
 * which agents add to an option but leave out when they repeat it, escaped for RegExp.
 */
export function firstChoice(reply: ToolReply): { question_id: string; content: Record<string, string>; value: string; word: string } {
  const question = reply.data.question as { question_id: string; requested_schema: { properties?: Record<string, ChoiceField> } }
  const fields = Object.entries(question.requested_schema.properties ?? {})
  const [key, field] = fields.find(([, f]) => f.type === 'string' && (f.oneOf?.length || f.enum?.length)) ?? assert.fail(`no single-select field in ${JSON.stringify(question)}`)
  const value = field.oneOf?.[0]?.const ?? field.enum?.[0] ?? assert.fail('no option')
  const word = value.replace(/\s*\(.*\)\s*$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { question_id: question.question_id, content: { [key]: value }, value, word }
}

/** codex config.toml for a Codex CLI client that loads this server from dist and passes envVars through. */
export function clientToml(providerToml: string, home: string, toolTimeoutSec: number, envVars: string[] = ['OPENAI_API_KEY']): string {
  return [
    providerToml,
    '[mcp_servers.cockpit]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(DIST_CLI)}]`,
    `env_vars = ${JSON.stringify(envVars)}`,
    `tool_timeout_sec = ${toolTimeoutSec}`,
    '# codex exec runs with approval policy `never`, so the cockpit tools must be pre-approved',
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.cockpit.env]',
    `SUBAGENT_COCKPIT_HOME = ${JSON.stringify(home)}`,
    '',
  ].join('\n')
}

/** Run `codex exec` with an isolated client CODEX_HOME; resolves with exit code and combined output. */
export async function codexExec(clientHome: string, cwd: string, prompt: string): Promise<{ code: number | null; text: string }> {
  const child = spawn('codex', ['exec', '-c', 'model_reasoning_effort="low"', '--skip-git-repo-check', '-C', cwd, prompt], { env: { ...baseEnv(), CODEX_HOME: clientHome }, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { text: '' }
  child.stdout.on('data', (c: Buffer) => { out.text += c.toString() })
  child.stderr.on('data', (c: Buffer) => { out.text += c.toString() })
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve))
  return { code, text: out.text }
}

/** A port nothing listens on right now. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  return typeof address === 'object' && address ? address.port : 0
}

/** pids of the webui processes serving the port, found by command line. */
export function webuiPids(port: number): number[] {
  const pattern = new RegExp(`webui\\.js --port ${port}(\\s|$)`)
  return execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf-8' })
    .split('\n')
    .filter(line => pattern.test(line))
    .map(line => Number.parseInt(line.trim(), 10))
}

export function childPids(pid: number): number[] {
  const out = (() => {
    try {
      return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' })
    } catch {
      return ''
    }
  })()
  return out.split('\n').filter(Boolean).map(Number)
}
