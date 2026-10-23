// End-to-end tests against the local grok, which speaks ACP itself. Not part of `npm test`.
//
// Provider: COCKPIT_E2E_GROK_CONFIG names a grok config.toml (e.g. custom endpoints whose key comes from
// the env var named by its env_key, usually XAI_API_KEY). Every run copies it into a temporary GROK_HOME
// with permission_mode set to ask, and points HOME at another temporary dir so grok does not read the
// local ~/.claude permission settings and plugins; approvals are then predictable. The local auth.json is
// never read or copied. Without it, the local grok config and login are used as they are, and the cases
// that rely on approvals (E27 to E30) are skipped. This isolation belongs to the tests only; the product
// passes the subagent env through untouched. No address or credential is written in this file.
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalId, childPids, clientToml, codexExec, COLOR_PROMPT, exists, firstChoice, itemText, openSession, promptIn, replayed, snapshotItems, startServer, TURN_TIMEOUT } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { isAlive, until } from '../../fixtures/harness'
import type { ToolReply } from '../../fixtures/harness'
import { approvals, expectAnsweredTurn, sessionsOf, showLatest, startWatched } from '../../fixtures/page'
import type { Watched } from '../../fixtures/page'

/** A recorded observation, kept as an annotation in the report. */
const diagnostic = (description: string) => test.info().annotations.push({ type: 'diagnostic', description })

const GROK_CONFIG = process.env.COCKPIT_E2E_GROK_CONFIG
const CODEX_PROVIDER_CONFIG = process.env.COCKPIT_E2E_CODEX_CONFIG
const NEEDS_ASK = !GROK_CONFIG && 'approvals depend on the local grok config; set COCKPIT_E2E_GROK_CONFIG'
const NOTE = 'PELICAN-4711'

interface Env {
  root: string
  home: string
  grokHome: string
  work: string
}

interface ConfigOption {
  id: string
  current_value: string
}

/** Same config with [ui] permission_mode = "ask". */
function askMode(toml: string): string {
  if (/^permission_mode\s*=/m.test(toml)) return toml.replace(/^permission_mode\s*=.*$/m, 'permission_mode = "ask"')
  if (/^\[ui\]\s*$/m.test(toml)) return toml.replace(/^\[ui\]\s*$/m, '[ui]\npermission_mode = "ask"')
  return `${toml}\n[ui]\npermission_mode = "ask"\n`
}

/** Isolated cockpit home and work dir; with COCKPIT_E2E_GROK_CONFIG also GROK_HOME and HOME, shared through the `gx` profile. */
async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-e2e-grok-'))
  const env = {
    root,
    home: join(root, 'home'),
    grokHome: GROK_CONFIG ? join(root, 'grok-home') : process.env.GROK_HOME || join(homedir(), '.grok'),
    work: join(root, 'work'),
  }
  await Promise.all([mkdir(env.home), mkdir(env.work)])
  await writeFile(join(env.work, 'note.txt'), `${NOTE}\n`)
  const gx = GROK_CONFIG
    ? { env: { GROK_HOME: env.grokHome, HOME: join(root, 'user-home'), XAI_API_KEY: '${XAI_API_KEY}' } }
    : {}
  if (GROK_CONFIG) {
    await Promise.all([mkdir(env.grokHome), mkdir(join(root, 'user-home'))])
    await writeFile(join(env.grokHome, 'config.toml'), askMode(await readFile(GROK_CONFIG, 'utf-8')))
  }
  const sub = (extra: object = {}) => ({ adapter: 'grok', profile: 'gx', ...extra })
  await writeFile(join(env.home, 'config.json'), JSON.stringify({
    idle: { timeout: 0 },
    webui: { port: 0 },
    profiles: { gx },
    subagents: {
      grok: sub(),
      low: sub({ reasoning_effort: 'low', mode: 'plan' }),
      yolo: sub({ args: ['--always-approve'] }),
    },
  }))
  return env
}

// Ask mode runs `touch` without asking; a redirect is a write it asks about
const writePrompt = (file: string) => `Run exactly the shell command \`echo hi > ${file}\` in the current directory, even if the file already exists. Run no other command and do not inspect or remove the file. Then reply DONE.`

/** Relative path -> content of every permission*.toml under GROK_HOME/sessions. */
async function permissionFiles(grokHome: string): Promise<Record<string, string>> {
  const dir = join(grokHome, 'sessions')
  const files = (await readdir(dir, { recursive: true }).catch(() => [])).map(String).filter(f => /(^|\/)permission[^/]*\.toml$/.test(f))
  return Object.fromEntries(await Promise.all(files.map(async f => [f, await readFile(join(dir, f), 'utf-8')])))
}

/** Entries under GROK_HOME/sessions whose path contains the native session id. */
const nativeEntries = async (grokHome: string, nativeId: string) =>
  (await readdir(join(grokHome, 'sessions'), { recursive: true }).catch(() => [])).map(String).filter(f => f.includes(nativeId))

test.describe('grok e2e', () => {
  // Later cases build on the sessions of earlier ones
  test.describe.configure({ mode: 'serial' })
  const ctx: { env?: Env; server?: Server; watched?: Watched; session?: string } = {}
  const server = () => ctx.server ?? assert.fail('server not started')
  const page = () => ctx.watched?.page ?? assert.fail('page not open')
  const env = () => ctx.env ?? assert.fail('env not ready')
  const configOf = (reply: ToolReply, id: string) => (reply.data.config_options as ConfigOption[]).find(o => o.id === id)

  test.beforeAll(async ({ browser }) => {
    ctx.env = await makeEnv()
    // E71: the group's webui stays open in the browser throughout
    ctx.watched = await startWatched(browser, ctx.env.home)
    ctx.server = ctx.watched.server
  })

  test.afterAll(async () => {
    await ctx.watched?.close()
    ctx.env && await rm(ctx.env.root, { recursive: true, force: true })
  })

  test('E26 a read-only task completes', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'grok')
    const session = String(opened.data.session)
    assert.match(session, /^grok_/)
    const r = await promptIn(server(), session, 'Read the file note.txt in the current directory and reply with its exact content only. Do not modify anything.')
    assert.equal(r.isError, false, JSON.stringify(r.data))
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
    assert.match(String(r.data.output), new RegExp(NOTE))
    ctx.session = session
    await expectAnsweredTurn(page(), 'grok', /Read the file note\.txt/, new RegExp(NOTE))
  })

  async function askForApproval(file: string): Promise<{ session: string; reply: ToolReply }> {
    const session = String((await openSession(server(), env().work, 'grok')).data.session)
    const reply = await promptIn(server(), session, writePrompt(file))
    assert.equal(reply.data.status, 'approval_needed', `expected an approval, got ${JSON.stringify(reply.data)}`)
    return { session, reply }
  }

  test('E27 approve a command', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const { session, reply } = await askForApproval('approved.txt')
    const conversation = await showLatest(page(), 'grok')
    await expect(approvals(conversation).first()).toContainText('waiting for an answer')
    const done = await server().call('approve', { session, approval_id: approvalId(reply) })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    await expect(approvals(conversation).first()).toContainText('approved once')
    assert.ok(await exists(join(env().work, 'approved.txt')))
  })

  test('E28 allow: not asked again in the session, nothing persisted, asked again after a reconnect (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const configBefore = await readFile(join(env().grokHome, 'config.toml'), 'utf-8')
    const { session, reply } = await askForApproval('allowed-1.txt')
    const baseline = await permissionFiles(env().grokHome)
    const first = await server().call('allow', { session, approval_id: approvalId(reply) })
    assert.equal(first.data.status, 'done', JSON.stringify(first.data))
    const second = await promptIn(server(), session, writePrompt('allowed-1.txt'))
    diagnostic(`E28 same command again: ${second.data.status}`)
    second.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(second) })
    assert.equal(second.data.status, 'done', JSON.stringify(second.data))
    const current = await permissionFiles(env().grokHome)
    diagnostic(`E28 permission files before ${JSON.stringify(Object.keys(baseline))}, after ${JSON.stringify(Object.keys(current))}`)
    assert.deepEqual(current, baseline)
    assert.equal(await readFile(join(env().grokHome, 'config.toml'), 'utf-8'), configBefore)
    assert.equal(await exists(join(env().work, '.grok')), false)
    await server().call('close', { session })
    const reopened = await server().call('open', { subagent: 'grok', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const third = await promptIn(server(), session, writePrompt('allowed-1.txt'))
    diagnostic(`E28 same command after reconnect: ${third.data.status}`)
    third.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(third) })
    assert.equal(third.data.status, 'approval_needed', JSON.stringify(third.data))
  })

  // Grok ends the turn on reject-once (stopReason cancelled, no reply); the session stays usable
  test('E29 reject: grok ends the turn as cancelled, the session takes the next prompt', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const { session, reply } = await askForApproval('rejected.txt')
    const done = await server().call('reject', { session, approval_id: approvalId(reply) })
    assert.deepEqual([done.data.status, done.data.outcome], ['done', 'cancelled'], JSON.stringify(done.data))
    assert.equal(await exists(join(env().work, 'rejected.txt')), false)
    const next = await promptIn(server(), session, 'Reply with exactly OK. Do not run any tools.')
    assert.equal(next.data.status, 'done', JSON.stringify(next.data))
    assert.match(String(next.data.output), /OK/)
  })

  test('E30 cancel a long task', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const session = String((await openSession(server(), env().work, 'grok')).data.session)
    const asked = await promptIn(server(), session, 'Run exactly the shell command `sleep 60 && echo done > slept.txt` in the current directory, then reply FINISHED.')
    assert.equal(asked.data.status, 'approval_needed', JSON.stringify(asked.data))
    await server().call('approve', { session, approval_id: approvalId(asked), wait: false })
    await new Promise(resolve => setTimeout(resolve, 5000))
    const cancelled = await server().call('cancel', { session })
    assert.ok(['cancelling', 'done'].includes(String(cancelled.data.status)))
    await until(async () => (await server().call('status', { session })).data.state === 'IDLE', 60_000, 'cancel finished')
  })

  test('E31 initial reasoning_effort, mode ignored with a note, then set_config (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'low')
    assert.equal(configOf(opened, 'reasoning_effort')?.current_value, 'low')
    assert.match(server().stderr(), /grok adapter ignores mode/)
    const session = String(opened.data.session)
    const changed = await server().call('set_config', { session, config_id: 'reasoning_effort', value: 'high' })
    diagnostic(`E31 set_config with a string value: ${changed.isError ? JSON.stringify(changed.data) : 'accepted'}`)
    assert.equal(changed.isError, false, JSON.stringify(changed.data))
    const config = (await server().call('status', { session })).data.config as Record<string, string>
    assert.equal(config.reasoning_effort, 'high')
  })

  test('E32 close and reconnect: history replays and the conversation continues', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = ctx.session ?? assert.fail('E26 session missing')
    await server().call('close', { session })
    await expect(sessionsOf(page(), 'grok').filter({ hasText: 'CLOSED' })).toHaveCount(1)
    const reopened = await server().call('open', { subagent: 'grok', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const history = replayed(await snapshotItems(server(), session))
    assert.ok(history.some(item => new RegExp(NOTE).test(itemText(item))), 'the replayed history should include the earlier reply')
    const r = await promptIn(server(), session, 'What was the content of note.txt you read earlier? Answer from memory, without reading it again.')
    assert.match(String(r.data.output), new RegExp(NOTE))
  })

  test('E33 args reach grok, also after a reconnect (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'yolo')).data.session)
    const first = await promptIn(server(), session, writePrompt('yolo-1.txt'))
    assert.equal(first.data.status, 'done', JSON.stringify(first.data))
    assert.ok(await exists(join(env().work, 'yolo-1.txt')))
    await server().call('close', { session })
    await server().call('open', { subagent: 'yolo', cwd: env().work, session })
    const again = await promptIn(server(), session, writePrompt('yolo-2.txt'))
    diagnostic(`E33 after reconnect: ${again.data.status}`)
    again.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(again) })
    assert.equal(again.data.status, 'done', JSON.stringify(again.data))
    assert.ok(await exists(join(env().work, 'yolo-2.txt')))
  })

  test('E34 delete open and closed sessions: no native files left behind (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const open = String((await openSession(server(), env().work, 'grok')).data.session)
    const closed = String((await openSession(server(), env().work, 'grok')).data.session)
    await Promise.all([open, closed].map(session => promptIn(server(), session, 'Reply with exactly OK. Do not run any tools.')))
    await server().call('close', { session: closed })
    const ids = [open, closed].map(session => session.replace(/^grok_/, ''))
    await Promise.all(ids.map(async id => assert.ok((await nativeEntries(env().grokHome, id)).length > 0, `native session ${id} missing before delete`)))
    await [open, closed].reduce(async (prev, session) => {
      await prev
      const deleted = await server().call('delete', { session })
      assert.equal(deleted.isError, false, JSON.stringify(deleted.data))
      assert.equal(deleted.data.native, 'deleted')
      assert.equal(await exists(join(env().home, 'sessions', session)), false)
    }, Promise.resolve())
    // grok might write session files back while shutting down; give it time to show up
    await new Promise(resolve => setTimeout(resolve, 3000))
    const left = await Promise.all(ids.map(id => nativeEntries(env().grokHome, id)))
    diagnostic(`E34 native entries 3s after delete: open ${left[0].length}, closed ${left[1].length}`)
    assert.deepEqual(left, [[], []])
  })

  test('E55 a question prompt: question_needed or done (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'grok')).data.session)
    const asked = await promptIn(server(), session, COLOR_PROMPT)
    diagnostic(`E55 status: ${asked.data.status}; output: ${String(asked.data.output ?? '').slice(0, 200)}`)
    if (asked.data.status !== 'question_needed') return
    const { question_id, content, value } = firstChoice(asked)
    const done = await server().call('answer', { session, question_id, content })
    diagnostic(`E55 after answering ${value}: ${done.data.status}: ${String(done.data.output ?? '').slice(0, 200)}`)
  })

  test('E56 a todo plan shows in progress; replay after a reconnect is recorded', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'grok')).data.session)
    const prompt = 'Make a 3-step todo plan for writing a short poem, track it with your todo tool, and mark each step completed as you go. Write the poem in your reply only; do not create files or run shell commands.'
    const finish = async (reply: ToolReply): Promise<ToolReply> => (reply.data.status === 'approval_needed'
      ? finish(await server().call('approve', { session, approval_id: approvalId(reply) }))
      : reply)
    const done = await finish(await promptIn(server(), session, prompt))
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    const plan = async () => (await server().call('progress', { session })).data.plan as Array<{ content: string; status: string }>
    const before = await plan()
    diagnostic(`E56 plan: ${JSON.stringify(before)}`)
    assert.ok(before.length > 0)
    await server().call('close', { session })
    await server().call('open', { subagent: 'grok', cwd: env().work, session })
    diagnostic(`E56 plan after reconnect: ${JSON.stringify(await plan())}`)
  })
})

test.describe('grok e2e: processes and clients', () => {
  test('E35 SIGKILL of the MCP server leaves no grok behind (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const env = await makeEnv()
    const server = await startServer(env.home)
    try {
      const session = String((await openSession(server, env.work, 'grok')).data.session)
      await promptIn(server, session, 'Reply with exactly OK. Do not run any tools.')
      const serverPid = server.pid ?? assert.fail('no server pid')
      const grok = childPids(serverPid)
      const descendants = grok.flatMap(childPids)
      assert.ok(grok.length > 0, `grok ${grok}`)
      process.kill(serverPid, 'SIGKILL')
      const gone = await until(() => [...grok, ...descendants].every(p => !isAlive(p)), 10_000, 'grok processes exit').then(() => true, () => false)
      diagnostic(`E35 grok processes gone within 10s: ${gone} (grok ${grok.length}, descendants ${descendants.length})`)
      assert.ok(gone)
    } finally {
      await server.close().catch(() => undefined)
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E36 Codex CLI as the MCP client delegates to grok', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!CODEX_PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const env = await makeEnv()
    const clientHome = join(env.root, 'client-codex-home')
    await mkdir(clientHome)
    await writeFile(join(clientHome, 'config.toml'), clientToml(await readFile(CODEX_PROVIDER_CONFIG ?? '', 'utf-8'), env.home, 300, ['OPENAI_API_KEY', 'XAI_API_KEY']))
    try {
      const prompt = `Use the cockpit MCP server. Call its open tool with subagent "grok" and cwd "${env.work}". Then call its prompt tool with the returned session and text "Reply with exactly PONG. Do not run any tools.". Finally print the output field you received.`
      const { code, text } = await codexExec(clientHome, env.work, prompt)
      assert.equal(code, 0, text.slice(-2000))
      assert.match(text.slice(text.lastIndexOf('cockpit/prompt')), /PONG/)
      const sessions = await readdir(join(env.home, 'sessions'))
      assert.deepEqual(sessions.map(s => s.split('_')[0]), ['grok'])
    } finally {
      await rm(env.root, { recursive: true, force: true })
    }
  })
})
