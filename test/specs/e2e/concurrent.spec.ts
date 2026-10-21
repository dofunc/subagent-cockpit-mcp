// End-to-end test of one MCP connection driving codex, claude, grok, opencode and antigravity at the same time.
// Not part of `npm test`.
//
// Needs codex, claude, grok, opencode and agy on PATH. Providers follow the single-agent suites and are each optional:
// COCKPIT_E2E_CODEX_CONFIG is copied into a temporary CODEX_HOME; with ANTHROPIC_BASE_URL set, claude gets a
// temporary CLAUDE_CONFIG_DIR and the gateway variables through ${VAR}; COCKPIT_E2E_GROK_CONFIG is copied into
// a temporary GROK_HOME, HOME points at another temporary dir and XAI_API_KEY comes through ${VAR};
// COCKPIT_E2E_OPENCODE_CONFIG is copied to a temporary OPENCODE_CONFIG with HOME and the XDG dirs on temporary
// dirs, the key coming from the environment. Without them the local logins are used. agy always uses the local
// login on the real HOME, with COCKPIT_E2E_AGY_MODEL (default gemini-3.8-flash) at low effort. The tasks run no
// tools, so approvals do not matter. No address or credential is written in this file.
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject, JsonValue } from '../../../src/types'
import { subscribe } from '../../fixtures/browser'
import type { Stream } from '../../fixtures/browser'
import { childPids, promptIn, TURN_TIMEOUT, webuiPids } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { until } from '../../fixtures/harness'
import { sessionsOf, showLatest, startWatched } from '../../fixtures/page'
import type { Watched } from '../../fixtures/page'

/** A recorded observation, kept as an annotation in the report. */
const diagnostic = (description: string) => test.info().annotations.push({ type: 'diagnostic', description })

const CODEX_CONFIG = process.env.COCKPIT_E2E_CODEX_CONFIG
const GROK_CONFIG = process.env.COCKPIT_E2E_GROK_CONFIG
const OPENCODE_CONFIG = process.env.COCKPIT_E2E_OPENCODE_CONFIG
const GATEWAY = Boolean(process.env.ANTHROPIC_BASE_URL)
const AGY_MODEL = process.env.COCKPIT_E2E_AGY_MODEL ?? 'gemini-3.8-flash'
const VENDORS = ['codex', 'claude', 'grok', 'opencode', 'antigravity'] as const

type Vendor = typeof VENDORS[number]

interface Env {
  root: string
  home: string
  work: string
}

/** Isolated cockpit home with one subagent per vendor, each on its own provider. */
async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-e2e-concurrent-'))
  const dir = (name: string) => join(root, name)
  const opencodeDirs = ['opencode-home', 'xdg-config', 'xdg-data', 'xdg-state', 'xdg-cache']
  await Promise.all(['home', 'work', 'codex-home', 'claude-config', 'grok-home', 'user-home', ...opencodeDirs].map(name => mkdir(dir(name))))
  CODEX_CONFIG && await copyFile(CODEX_CONFIG, join(dir('codex-home'), 'config.toml'))
  GROK_CONFIG && await copyFile(GROK_CONFIG, join(dir('grok-home'), 'config.toml'))
  OPENCODE_CONFIG && await copyFile(OPENCODE_CONFIG, dir('opencode.json'))
  const codexEnv = CODEX_CONFIG ? { CODEX_HOME: dir('codex-home') } : {}
  const claudeEnv = GATEWAY
    ? {
      CLAUDE_CONFIG_DIR: dir('claude-config'),
      ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}',
      ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    }
    : {}
  const grokEnv = GROK_CONFIG ? { GROK_HOME: dir('grok-home'), HOME: dir('user-home'), XAI_API_KEY: '${XAI_API_KEY}' } : {}
  const opencodeEnv = OPENCODE_CONFIG
    ? {
      OPENCODE_CONFIG: dir('opencode.json'),
      HOME: dir('opencode-home'),
      XDG_CONFIG_HOME: dir('xdg-config'),
      XDG_DATA_HOME: dir('xdg-data'),
      XDG_STATE_HOME: dir('xdg-state'),
      XDG_CACHE_HOME: dir('xdg-cache'),
    }
    : {}
  await writeFile(join(dir('home'), 'config.json'), JSON.stringify({
    idle: { timeout: 0 },
    webui: { port: 0 },
    subagents: {
      codex: { adapter: 'codex', reasoning_effort: 'low', env: codexEnv },
      claude: { adapter: 'claude', mode: 'default', env: claudeEnv },
      grok: { adapter: 'grok', env: grokEnv },
      opencode: { adapter: 'opencode', env: opencodeEnv },
      antigravity: { adapter: 'antigravity', model: AGY_MODEL, reasoning_effort: 'low' },
    },
  }))
  return { root, home: dir('home'), work: dir('work') }
}

const tag = (vendor: Vendor, round: number) => `${vendor.toUpperCase()}-ROUND-${round}`
const task = (vendor: Vendor, round: number) => `Write the numbers 1 to 30 separated by spaces, then ${tag(vendor, round)} on its own line. Do not run any tools.`

/** The command line of a process. */
const commandOf = (pid: number) => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).trim()

/** A JSON object field as an object; anything else reads as empty. */
const objectOf = (value: JsonValue | undefined): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** The output carries the vendor's own tag for this round and none of the others'. */
function assertOwnOutput(vendor: Vendor, round: number, output: string): void {
  assert.match(output, new RegExp(tag(vendor, round)), `${vendor}: ${output}`)
  VENDORS.filter(v => v !== vendor).forEach(v => assert.doesNotMatch(output, new RegExp(tag(v, round)), `${vendor}: ${output}`))
}

test.describe('concurrent e2e', () => {
  // Later cases build on the sessions of earlier ones
  test.describe.configure({ mode: 'serial' })
  const ctx: { env?: Env; server?: Server; watched?: Watched; stream?: Stream; sessions?: string[] } = {}
  const server = () => ctx.server ?? assert.fail('server not started')
  const page = () => ctx.watched?.page ?? assert.fail('page not open')
  const env = () => ctx.env ?? assert.fail('env not ready')
  const sessions = () => ctx.sessions ?? assert.fail('sessions not opened')
  const states = async () => (await Promise.all(sessions().map(session => server().call('status', { session })))).map(r => r.data.state)

  test.beforeAll(async ({ browser }) => {
    ctx.env = await makeEnv()
    // E68: the webui stays open in the browser, and the test follows its stream as a second viewer
    ctx.watched = await startWatched(browser, ctx.env.home)
    ctx.server = ctx.watched.server
    ctx.stream = await subscribe(ctx.watched.port)
  })

  test.afterAll(async () => {
    ctx.stream?.close()
    await ctx.watched?.close()
    ctx.env && await rm(ctx.env.root, { recursive: true, force: true })
  })

  test('E37 five subagents open concurrently on one connection, one agent process each', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const replies = await Promise.all(VENDORS.map(subagent => server().call('open', { subagent, cwd: env().work })))
    replies.forEach((r, i) => {
      assert.equal(r.isError, false, JSON.stringify(r.data))
      assert.match(String(r.data.session), new RegExp(`^${VENDORS[i]}_`))
    })
    ctx.sessions = replies.map(r => String(r.data.session))
    // With the webui on, the server may have one more direct child: told apart by command line
    const children = childPids(server().pid ?? assert.fail('no server pid')).map(commandOf)
    const webuis = children.filter(command => /webui\.js/.test(command))
    assert.equal(children.length - webuis.length, VENDORS.length, children.join('\n'))
    assert.ok(webuis.length <= 1, children.join('\n'))
  })

  test('E38 blocking prompts to all five run at the same time, each with its own reply', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const started = Date.now()
    const pending = sessions().map((session, i) => promptIn(server(), session, task(VENDORS[i], 1)).then(reply => ({ reply, seconds: (Date.now() - started) / 1000 })))
    // Status answers while the five blocking calls are in flight, and shows all five turns running together
    await until(async () => (await states()).every(state => state === 'RUNNING'), 30_000, 'all five running at once')
    const calls = await Promise.all(pending)
    calls.forEach(({ reply, seconds }, i) => {
      diagnostic(`E38 ${VENDORS[i]} returned after ${seconds.toFixed(1)}s`)
      assert.equal(reply.data.status, 'done', JSON.stringify(reply.data))
      assertOwnOutput(VENDORS[i], 1, String(reply.data.output))
    })
  })

  test('E39 wait:false prompts return at once, then status and output pick up each result', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const sent = await Promise.all(sessions().map((session, i) => server().call('prompt', { session, text: task(VENDORS[i], 2), wait: false })))
    sent.forEach(r => assert.equal(r.data.status, 'running', JSON.stringify(r.data)))
    await until(async () => (await states()).every(state => state === 'IDLE'), 300_000, 'all five idle')
    const outputs = await Promise.all(sessions().map(session => server().call('output', { session })))
    outputs.forEach((r, i) => assertOwnOutput(VENDORS[i], 2, String(r.data.output)))
  })

  test('E68 the webui keeps the five sessions apart, shows each one, and exits after the server', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const activities = (ctx.stream ?? assert.fail('stream not subscribed')).of('activity')
    const messagesOf = (session: string) => activities
      .filter(a => a.session === session)
      .flatMap(({ activity }) => (activity.kind === 'acp' && !('truncated' in activity.message) ? [activity.message] : []))
    const updateOf = (params: JsonValue | undefined) => objectOf(objectOf(params).update).sessionUpdate
    sessions().forEach((session, i) => {
      const messages = messagesOf(session)
      assert.ok(activities.some(a => a.session === session && a.activity.kind === 'session_opened'), `${session}: session_opened`)
      assert.ok(messages.some(m => m.method === 'session/prompt'), `${session}: session/prompt`)
      assert.ok(messages.some(m => m.method === 'session/update' && updateOf(m.params) === 'agent_message_chunk'), `${session}: agent_message_chunk`)
      // Every message that names a session names this one; a null sessionId names none
      const named = [...new Set(messages.map(m => objectOf(m.params).sessionId).filter(id => typeof id === 'string'))]
      assert.deepEqual(named, [session.slice(VENDORS[i].length + 1)], session)
      const unnamed = messages.filter(m => objectOf(m.params).sessionId === null).map(m => m.method ?? `response #${m.id}`)
      unnamed.length > 0 && diagnostic(`E68 ${VENDORS[i]} messages with a null sessionId: ${[...new Set(unnamed)].join(', ')}`)
    })
    const updates = new Set(sessions().flatMap(session => messagesOf(session).map(m => updateOf(m.params)).filter(type => type !== undefined)))
    diagnostic(`E68 sessionUpdate types: ${[...updates].join(', ')}`)

    for (const vendor of VENDORS) {
      await expect(sessionsOf(page(), vendor)).toHaveCount(1)
      const conversation = await showLatest(page(), vendor)
      await expect(conversation.getByText(/Write the numbers 1 to 30/).first()).toBeVisible()
      await expect(conversation.getByText(new RegExp(tag(vendor, 2))).last()).toBeVisible()
    }

    const { port } = ctx.watched ?? assert.fail('webui not watched')
    await server().close()
    // Default grace period: 10 seconds
    await until(() => webuiPids(port).length === 0, 20_000, 'webui exits after the grace period')
  })
})
