// End-to-end tests against the local agy (Google Antigravity CLI) through the bundled bridge dist/agy-acp.js.
// Not part of `npm test`.
//
// agy only logs in from its own interactive terminal and keeps that login under HOME, so these tests use the real
// HOME and the local login; the whole suite is skipped when agy is missing or not logged in. The local agy
// permission rules (settings.json permissions.allow) apply as well: E59 needs an empty allow list and is skipped
// otherwise. agy has no way to delete a conversation, so every run leaves its conversations under
// ~/.gemini/antigravity-cli/. The model comes from COCKPIT_E2E_AGY_MODEL (default gemini-3.8-flash) at low effort.
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { childPids, clientToml, codexExec, COLOR_PROMPT, exists, openSession, promptIn, replayed, snapshotItems, startServer, TURN_TIMEOUT } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { isAlive, until } from '../../fixtures/harness'
import type { ToolReply } from '../../fixtures/harness'
import { expectAnsweredTurn, sessionsOf, showLatest, startWatched, turnEnd } from '../../fixtures/page'
import type { Watched } from '../../fixtures/page'

/** A recorded observation, kept as an annotation in the report. */
const diagnostic = (description: string) => test.info().annotations.push({ type: 'diagnostic', description })

const MODEL = process.env.COCKPIT_E2E_AGY_MODEL ?? 'gemini-3.8-flash'
const CODEX_PROVIDER_CONFIG = process.env.COCKPIT_E2E_CODEX_CONFIG
const AGY_DATA = join(homedir(), '.gemini', 'antigravity-cli')
const NOTE = 'PELICAN-4711'
const WORD = 'MARMALADE'

/** Why the suite cannot run: agy missing, or not logged in (agy answers with a result before init). No prompt is sent. */
async function agyUnavailable(): Promise<string | false> {
  const agy = (() => {
    try {
      return execFileSync('/bin/sh', ['-c', 'command -v agy'], { encoding: 'utf-8' }).trim()
    } catch {
      return ''
    }
  })()
  if (!agy) return 'agy is not installed'
  const child = spawn(agy, ['--input-format', 'stream-json', '--output-format', 'stream-json', '-p='], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] })
  const out = { text: '' }
  const first = await new Promise<string>(resolve => {
    child.stdout.on('data', (c: Buffer) => {
      out.text += c.toString()
      const event = /"event":"(init|result)"/.exec(out.text)?.[1]
      event && resolve(event)
    })
    child.once('exit', () => resolve('exit'))
    setTimeout(() => resolve('timeout'), 60_000)
  })
  child.stdin.end()
  child.kill('SIGINT')
  return first === 'init' ? false : 'agy is not logged in; run `agy` in a terminal and sign in'
}

/** Why E59 cannot run: the local agy settings already allow some actions. Only permissions.allow is read. */
async function allowsActions(): Promise<string | false> {
  const settings = JSON.parse(await readFile(join(AGY_DATA, 'settings.json'), 'utf-8').catch(() => '{}'))
  const allow: string[] = settings?.permissions?.allow ?? []
  return allow.length > 0 && 'local agy settings allow actions (permissions.allow); E59 needs an empty list'
}

const UNAVAILABLE = await agyUnavailable()
const NEEDS_DENY = await allowsActions()

interface Env {
  root: string
  home: string
  work: string
}

interface ConfigOption {
  id: string
  current_value: string
  options: Array<{ value: string }>
}

async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-e2e-agy-'))
  const dir = (name: string) => join(root, name)
  await Promise.all(['home', 'work'].map(name => mkdir(dir(name))))
  await writeFile(join(dir('work'), 'note.txt'), `${NOTE}\n`)
  const sub = (extra: object = {}) => ({ adapter: 'antigravity', model: MODEL, reasoning_effort: 'low', ...extra })
  await writeFile(join(dir('home'), 'config.json'), JSON.stringify({
    idle: { timeout: 0 },
    webui: { port: 0 },
    profiles: {},
    subagents: {
      antigravity: sub(),
      skip: sub({ args: ['--dangerously-skip-permissions'] }),
      planned: sub({ mode: 'plan' }),
    },
  }))
  return { root, home: dir('home'), work: dir('work') }
}

const writePrompt = (file: string) => `Run exactly the shell command \`echo hi > ${file}\` in the current directory. Run no other command. Then reply DONE.`
const OK_PROMPT = 'Reply with exactly OK. Do not run any tools.'
const configOf = (reply: ToolReply, id: string) => (reply.data.config_options as ConfigOption[]).find(o => o.id === id)
const nativeId = (session: string) => session.replace(/^antigravity_/, '')

test.describe('antigravity e2e', () => {
  // Later cases build on the sessions of earlier ones
  test.describe.configure({ mode: 'serial' })
  test.skip(Boolean(UNAVAILABLE), String(UNAVAILABLE))
  const ctx: { env?: Env; server?: Server; watched?: Watched } = {}
  const server = () => ctx.server ?? assert.fail('server not started')
  const page = () => ctx.watched?.page ?? assert.fail('page not open')
  const env = () => ctx.env ?? assert.fail('env not ready')
  /** Each tool item's title, kind and status, from the snapshot conversation */
  const toolCalls = async (session: string) => (await snapshotItems(server(), session))
    .filter(item => item.kind === 'tool')
    .map(({ data }) => ({ title: data.title, kind: data.kind, status: data.status }))

  test.beforeAll(async ({ browser }) => {
    ctx.env = await makeEnv()
    // E73: the group's webui stays open in the browser throughout
    ctx.watched = await startWatched(browser, ctx.env.home)
    ctx.server = ctx.watched.server
  })

  test.afterAll(async () => {
    await ctx.watched?.close()
    ctx.env && await rm(ctx.env.root, { recursive: true, force: true })
  })

  test('E58 a read-only task completes with a read tool call', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'antigravity')).data.session)
    assert.match(session, /^antigravity_/)
    const r = await promptIn(server(), session, 'Read the file note.txt in the current directory and reply with its exact content only. Do not modify anything.')
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
    assert.match(String(r.data.output), new RegExp(NOTE))
    const calls = await toolCalls(session)
    assert.ok(calls.some(c => c.kind === 'read'), JSON.stringify(calls))
    await expectAnsweredTurn(page(), 'antigravity', /Read the file note\.txt/, new RegExp(NOTE))
    const conversation = await showLatest(page(), 'antigravity')
    await expect(conversation.getByRole('button', { name: / read completed/ }).first()).toBeVisible()
  })

  test('E59 without a permission the command is denied, never asked (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_DENY), String(NEEDS_DENY))
    const session = String((await openSession(server(), env().work, 'antigravity')).data.session)
    const r = await promptIn(server(), session, writePrompt('denied.txt'))
    diagnostic(`E59 output: ${JSON.stringify(r.data.output)}`)
    const calls = await toolCalls(session)
    diagnostic(`E59 tool calls: ${JSON.stringify(calls)}`)
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
    assert.equal(await exists(join(env().work, 'denied.txt')), false)
    assert.match(String(r.data.output), /agy denied in headless mode/)
  })

  test('E60 --dangerously-skip-permissions in args lets commands run, also after a reconnect', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'skip')).data.session)
    const first = await promptIn(server(), session, writePrompt('allowed-1.txt'))
    assert.equal(first.data.status, 'done', JSON.stringify(first.data))
    assert.ok(await exists(join(env().work, 'allowed-1.txt')))
    await server().call('close', { session })
    const reopened = await server().call('open', { subagent: 'skip', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const second = await promptIn(server(), session, writePrompt('allowed-2.txt'))
    assert.equal(second.data.status, 'done', JSON.stringify(second.data))
    assert.ok(await exists(join(env().work, 'allowed-2.txt')))
  })

  test('E61 cancel a long reply; the conversation goes on (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'antigravity')).data.session)
    await promptIn(server(), session, `Remember the word ${WORD}. Reply with exactly OK.`)
    const pending = promptIn(server(), session, 'Write the numbers from 1 to 2000, one per line, and nothing else. Do not run any tools.')
    await until(async () => String((await server().call('output', { session })).data.output ?? '').length > 0, 120_000, 'partial output')
    await server().call('cancel', { session })
    const r = await pending
    assert.deepEqual([r.data.status, r.data.outcome], ['done', 'cancelled'], JSON.stringify(r.data))
    assert.equal((await server().call('status', { session })).data.state, 'IDLE')
    await expect(turnEnd(await showLatest(page(), 'antigravity'), 'cancelled')).toBeVisible()
    const next = await promptIn(server(), session, 'Which word did I ask you to remember? Reply with the word only.')
    diagnostic(`E61 after cancel: ${JSON.stringify(next.data.output)}`)
    assert.equal(next.data.status, 'done', JSON.stringify(next.data))
    assert.match(String(next.data.output), new RegExp(WORD, 'i'))
  })

  test('E62 initial config, then set_config; the next turn runs on it', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'planned')
    assert.deepEqual(['model', 'reasoning_effort', 'mode'].map(id => configOf(opened, id)?.current_value), [MODEL, 'low', 'plan'])
    const session = String(opened.data.session)
    const effort = await server().call('set_config', { session, config_id: 'reasoning_effort', value: 'medium' })
    assert.equal(effort.isError, false, JSON.stringify(effort.data))
    const other = configOf(opened, 'model')?.options.map(o => o.value).find(v => v !== 'default' && v !== MODEL && /gpt-oss|flash/.test(v))
      ?? configOf(opened, 'model')?.options.map(o => o.value).find(v => v !== 'default' && v !== MODEL)
      ?? assert.fail('no other model')
    const model = await server().call('set_config', { session, config_id: 'model', value: other })
    assert.equal(model.isError, false, JSON.stringify(model.data))
    const config = (await server().call('status', { session })).data.config as Record<string, string>
    diagnostic(`E62 config after set_config: ${JSON.stringify(config)}`)
    assert.equal(config.model, other)
    const r = await promptIn(server(), session, OK_PROMPT)
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
  })

  test('E63 close and reconnect: no replay, the conversation continues', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'antigravity')).data.session)
    await promptIn(server(), session, `Remember the word ${WORD}. Reply with exactly OK.`)
    await server().call('close', { session })
    await expect(sessionsOf(page(), 'antigravity').filter({ hasText: 'CLOSED' })).toHaveCount(1)
    const reopened = await server().call('open', { subagent: 'antigravity', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    // agy does not replay: no history outside a turn, and the turn before the close is still there
    const items = await snapshotItems(server(), session)
    assert.deepEqual(replayed(items), [])
    assert.ok(items.some(item => item.kind === 'prompt' && JSON.stringify(item.data.prompt ?? null).includes(WORD)))
    const r = await promptIn(server(), session, 'Which word did I ask you to remember? Reply with the word only.')
    assert.match(String(r.data.output), new RegExp(WORD, 'i'))
  })

  test('E64 delete open and closed sessions: unsupported natively, agy keeps its files (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const open = String((await openSession(server(), env().work, 'antigravity')).data.session)
    const closed = String((await openSession(server(), env().work, 'antigravity')).data.session)
    await Promise.all([open, closed].map(session => promptIn(server(), session, OK_PROMPT)))
    await server().call('close', { session: closed })
    await [open, closed].reduce(async (prev, session) => {
      await prev
      const deleted = await server().call('delete', { session })
      assert.equal(deleted.isError, false, JSON.stringify(deleted.data))
      assert.equal(deleted.data.native, 'unsupported')
      assert.equal(await exists(join(env().home, 'sessions', session)), false)
    }, Promise.resolve())
    const kept = await readdir(join(AGY_DATA, 'conversations')).catch(() => [])
    const left = [open, closed].map(s => kept.some(f => f.startsWith(nativeId(s))))
    diagnostic(`E64 agy conversation files still there: ${JSON.stringify(left)}`)
    assert.deepEqual(left, [true, true])
  })

  test('E67 a question is skipped by agy, never question_needed (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'antigravity')).data.session)
    const r = await promptIn(server(), session, COLOR_PROMPT)
    diagnostic(`E67 reply: ${JSON.stringify(r.data.output)}`)
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
  })
})

test.describe('antigravity e2e: processes and clients', () => {
  test.skip(Boolean(UNAVAILABLE), String(UNAVAILABLE))
  test('E65 SIGKILL of the MCP server during a turn leaves no bridge or agy behind (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const env = await makeEnv()
    const server = await startServer(env.home)
    try {
      const session = String((await openSession(server, env.work, 'antigravity')).data.session)
      await server.call('prompt', { session, text: 'Write the numbers from 1 to 2000, one per line, and nothing else. Do not run any tools.', wait: false })
      const serverPid = server.pid ?? assert.fail('no server pid')
      const bridges = childPids(serverPid)
      const agy = bridges.flatMap(childPids)
      const descendants = agy.flatMap(childPids)
      assert.ok(bridges.length > 0 && agy.length > 0, `bridge ${bridges}, agy ${agy}`)
      process.kill(serverPid, 'SIGKILL')
      const all = [...bridges, ...agy, ...descendants]
      const gone = await until(() => all.every(p => !isAlive(p)), 10_000, 'bridge and agy exit').then(() => true, () => false)
      diagnostic(`E65 gone within 10s: ${gone} (bridge ${bridges.length}, agy ${agy.length}, descendants ${descendants.length}); alive: ${all.filter(isAlive)}`)
      assert.ok(gone)
    } finally {
      await server.close().catch(() => undefined)
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E66 Codex CLI as the MCP client delegates to Antigravity', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!CODEX_PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const env = await makeEnv()
    const clientHome = join(env.root, 'client-codex-home')
    await mkdir(clientHome)
    await writeFile(join(clientHome, 'config.toml'), clientToml(await readFile(CODEX_PROVIDER_CONFIG ?? '', 'utf-8'), env.home, 300, ['OPENAI_API_KEY', 'HOME']))
    try {
      const prompt = `Use the cockpit MCP server. Call its open tool with subagent "antigravity" and cwd "${env.work}". Then call its prompt tool with the returned session and text "Reply with exactly PONG. Do not run any tools.". Finally print the output field you received.`
      const { code, text } = await codexExec(clientHome, env.work, prompt)
      assert.equal(code, 0, text.slice(-2000))
      assert.match(text.slice(text.lastIndexOf('cockpit/prompt')), /PONG/)
      const sessions = await readdir(join(env.home, 'sessions'))
      assert.deepEqual(sessions.map(s => s.split('_')[0]), ['antigravity'])
    } finally {
      await rm(env.root, { recursive: true, force: true })
    }
  })
})
