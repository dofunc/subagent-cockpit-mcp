// End-to-end tests against the local opencode (V2), which speaks ACP itself. Not part of `npm test`.
//
// Provider: COCKPIT_E2E_OPENCODE_CONFIG names an opencode config (JSON) with the provider and model, e.g. a gateway
// whose apiKey is `{env:OPENAI_API_KEY}` and, when the gateway has no WebSocket, `transport: "http"`. Every run copies
// it to a temporary file with bash and edit permissions set to ask, and points OPENCODE_CONFIG at the copy, HOME and
// the XDG dirs at temporary dirs, so opencode reads neither the local opencode config, data and login nor the Claude
// Code skills; approvals are then predictable. The key comes from the environment. Without it, the local opencode
// config and login are used as they are, and the cases that rely on approvals (E41 to E44) are skipped. This
// isolation belongs to the tests only; the product passes the subagent env through untouched. No address or
// credential is written in this file.
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { approvalId, baseEnv, childPids, clientToml, codexExec, COLOR_PROMPT, exists, firstChoice, itemText, openSession, promptIn, replayed, snapshotItems, startServer, TURN_TIMEOUT } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { isAlive, until } from '../../fixtures/harness'
import type { ToolReply } from '../../fixtures/harness'
import { approvals, expectAnsweredTurn, sessionsOf, showLatest, startWatched } from '../../fixtures/page'
import type { Watched } from '../../fixtures/page'

/** A recorded observation, kept as an annotation in the report. */
const diagnostic = (description: string) => test.info().annotations.push({ type: 'diagnostic', description })

const OPENCODE_CONFIG = process.env.COCKPIT_E2E_OPENCODE_CONFIG
const CODEX_PROVIDER_CONFIG = process.env.COCKPIT_E2E_CODEX_CONFIG
const NEEDS_ASK = !OPENCODE_CONFIG && 'approvals depend on the local opencode config; set COCKPIT_E2E_OPENCODE_CONFIG'
const NOTE = 'PELICAN-4711'

interface Env {
  root: string
  home: string
  work: string
  /** What the `ox` profile sets for opencode; empty without COCKPIT_E2E_OPENCODE_CONFIG */
  agentEnv: Record<string, string>
}

interface ConfigOption {
  id: string
  current_value: string
}

/** Isolated cockpit home and work dir; with COCKPIT_E2E_OPENCODE_CONFIG also the opencode config, HOME and XDG dirs, shared through the `ox` profile. */
async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-e2e-opencode-'))
  const dir = (name: string) => join(root, name)
  const agentEnv: Record<string, string> = OPENCODE_CONFIG
    ? {
      OPENCODE_CONFIG: dir('opencode.json'),
      HOME: dir('user-home'),
      XDG_CONFIG_HOME: dir('xdg-config'),
      XDG_DATA_HOME: dir('xdg-data'),
      XDG_STATE_HOME: dir('xdg-state'),
      XDG_CACHE_HOME: dir('xdg-cache'),
    }
    : {}
  await Promise.all(['home', 'work', ...(OPENCODE_CONFIG ? ['user-home', 'xdg-config', 'xdg-data', 'xdg-state', 'xdg-cache'] : [])].map(name => mkdir(dir(name))))
  await writeFile(join(dir('work'), 'note.txt'), `${NOTE}\n`)
  OPENCODE_CONFIG && await writeFile(agentEnv.OPENCODE_CONFIG, JSON.stringify({
    ...JSON.parse(await readFile(OPENCODE_CONFIG, 'utf-8')),
    permission: { bash: 'ask', edit: 'ask' },
  }))
  const sub = (extra: object = {}) => ({ adapter: 'opencode', profile: 'ox', ...extra })
  await writeFile(join(dir('home'), 'config.json'), JSON.stringify({
    idle: { timeout: 0 },
    webui: { port: 0 },
    profiles: { ox: { env: agentEnv } },
    subagents: {
      opencode: sub(),
      low: sub({ reasoning_effort: 'low', mode: 'plan' }),
      logged: sub({ args: ['--log-level', 'warn'] }),
    },
  }))
  return { root, home: dir('home'), work: dir('work'), agentEnv }
}

const writePrompt = (file: string) => `Run exactly the shell command \`echo hi > ${file}\` in the current directory, even if the file already exists. Run no other command and do not inspect or remove the file. Then reply DONE.`
const OK_PROMPT = 'Reply with exactly OK. Do not run any tools.'

/** Native session ids opencode lists for cwd, asked through a fresh `opencode acp` on the same config and data. */
async function nativeSessions(env: Env, cwd: string): Promise<string[]> {
  const child = spawn('opencode', ['acp'], { cwd, env: { ...baseEnv(), ...env.agentEnv }, stdio: ['pipe', 'pipe', 'ignore'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      child.stdout.once('end', () => controller.close())
    },
  })
  const conn = new ClientSideConnection(() => ({
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    sessionUpdate: async () => undefined,
  }), ndJsonStream(Writable.toWeb(child.stdin), stdout))
  try {
    await conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
    return (await conn.listSessions({ cwd })).sessions.map(s => s.sessionId)
  } finally {
    child.stdin.end()
    await exited
  }
}

/** Files under opencode's data dir, relative to it. */
async function dataFiles(env: Env): Promise<string[]> {
  const dataDir = join(env.agentEnv.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode')
  return (await readdir(dataDir, { recursive: true }).catch(() => [])).map(String)
}

test.describe('opencode e2e', () => {
  // Later cases build on the sessions of earlier ones
  test.describe.configure({ mode: 'serial' })
  const ctx: { env?: Env; server?: Server; watched?: Watched; session?: string } = {}
  const server = () => ctx.server ?? assert.fail('server not started')
  const page = () => ctx.watched?.page ?? assert.fail('page not open')
  const env = () => ctx.env ?? assert.fail('env not ready')
  const configOf = (reply: ToolReply, id: string) => (reply.data.config_options as ConfigOption[]).find(o => o.id === id)

  test.beforeAll(async ({ browser }) => {
    ctx.env = await makeEnv()
    // E72: the group's webui stays open in the browser throughout
    ctx.watched = await startWatched(browser, ctx.env.home)
    ctx.server = ctx.watched.server
  })

  test.afterAll(async () => {
    await ctx.watched?.close()
    ctx.env && await rm(ctx.env.root, { recursive: true, force: true })
  })

  test('E40 a read-only task completes', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'opencode')
    const session = String(opened.data.session)
    assert.match(session, /^opencode_/)
    const r = await promptIn(server(), session, 'Read the file note.txt in the current directory and reply with its exact content only. Do not modify anything.')
    assert.equal(r.isError, false, JSON.stringify(r.data))
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
    assert.match(String(r.data.output), new RegExp(NOTE))
    ctx.session = session
    await expectAnsweredTurn(page(), 'opencode', /Read the file note\.txt/, new RegExp(NOTE))
  })

  async function askForApproval(file: string): Promise<{ session: string; reply: ToolReply }> {
    const session = String((await openSession(server(), env().work, 'opencode')).data.session)
    const reply = await promptIn(server(), session, writePrompt(file))
    assert.equal(reply.data.status, 'approval_needed', `expected an approval, got ${JSON.stringify(reply.data)}`)
    return { session, reply }
  }

  test('E41 approve a command', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const { session, reply } = await askForApproval('approved.txt')
    const conversation = await showLatest(page(), 'opencode')
    await expect(approvals(conversation).first()).toContainText('waiting for an answer')
    const done = await server().call('approve', { session, approval_id: approvalId(reply) })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    await expect(approvals(conversation).first()).toContainText('approved once')
    assert.ok(await exists(join(env().work, 'approved.txt')))
  })

  test('E42 allow: not asked again in the session, asked again after a reconnect (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const { session, reply } = await askForApproval('allowed-1.txt')
    const first = await server().call('allow', { session, approval_id: approvalId(reply) })
    assert.equal(first.data.status, 'done', JSON.stringify(first.data))
    const second = await promptIn(server(), session, writePrompt('allowed-1.txt'))
    diagnostic(`E42 same command again: ${second.data.status}`)
    second.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(second) })
    assert.equal(second.data.status, 'done', JSON.stringify(second.data))
    await server().call('close', { session })
    const reopened = await server().call('open', { subagent: 'opencode', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const third = await promptIn(server(), session, writePrompt('allowed-1.txt'))
    diagnostic(`E42 same command after reconnect: ${third.data.status}`)
    third.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(third) })
    assert.equal(third.data.status, 'approval_needed', JSON.stringify(third.data))
  })

  test('E43 reject: the file is not written, the session takes the next prompt (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const { session, reply } = await askForApproval('rejected.txt')
    const done = await server().call('reject', { session, approval_id: approvalId(reply) })
    diagnostic(`E43 after reject: status ${done.data.status}, outcome ${done.data.outcome}, output ${JSON.stringify(done.data.output)}`)
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    assert.equal(await exists(join(env().work, 'rejected.txt')), false)
    const next = await promptIn(server(), session, OK_PROMPT)
    assert.equal(next.data.status, 'done', JSON.stringify(next.data))
    assert.match(String(next.data.output), /OK/)
  })

  test('E44 cancel a long task', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(Boolean(NEEDS_ASK), String(NEEDS_ASK))
    const session = String((await openSession(server(), env().work, 'opencode')).data.session)
    const asked = await promptIn(server(), session, 'Run exactly the shell command `sleep 60 && echo done > slept.txt` in the current directory, then reply FINISHED.')
    assert.equal(asked.data.status, 'approval_needed', JSON.stringify(asked.data))
    await server().call('approve', { session, approval_id: approvalId(asked), wait: false })
    await new Promise(resolve => setTimeout(resolve, 5000))
    const cancelled = await server().call('cancel', { session })
    assert.ok(['cancelling', 'done'].includes(String(cancelled.data.status)))
    await until(async () => (await server().call('status', { session })).data.state === 'IDLE', 60_000, 'cancel finished')
    assert.equal(await exists(join(env().work, 'slept.txt')), false)
  })

  test('E45 initial effort and mode, then set_config', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'low')
    assert.deepEqual([configOf(opened, 'effort')?.current_value, configOf(opened, 'mode')?.current_value], ['low', 'plan'])
    const session = String(opened.data.session)
    const effort = await server().call('set_config', { session, config_id: 'effort', value: 'high' })
    assert.equal(effort.isError, false, JSON.stringify(effort.data))
    const mode = await server().call('set_config', { session, config_id: 'mode', value: 'build' })
    assert.equal(mode.isError, false, JSON.stringify(mode.data))
    const config = (await server().call('status', { session })).data.config as Record<string, string>
    assert.deepEqual([config.effort, config.mode], ['high', 'build'])
  })

  test('E46 close and reconnect: history replays and the conversation continues', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = ctx.session ?? assert.fail('E40 session missing')
    await server().call('close', { session })
    await expect(sessionsOf(page(), 'opencode').filter({ hasText: 'CLOSED' })).toHaveCount(1)
    const reopened = await server().call('open', { subagent: 'opencode', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const history = replayed(await snapshotItems(server(), session))
    assert.ok(history.some(item => new RegExp(NOTE).test(itemText(item))), 'the replayed history should include the earlier reply')
    const r = await promptIn(server(), session, 'What was the content of note.txt you read earlier? Answer from memory, without reading it again.')
    assert.match(String(r.data.output), new RegExp(NOTE))
  })

  test('E47 args go on the opencode command line, also after a reconnect (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'logged')).data.session)
    const first = await promptIn(server(), session, OK_PROMPT)
    assert.equal(first.data.status, 'done', JSON.stringify(first.data))
    await server().call('close', { session })
    const reopened = await server().call('open', { subagent: 'logged', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const again = await promptIn(server(), session, OK_PROMPT)
    diagnostic(`E47 after reconnect: ${again.data.status}`)
    assert.equal(again.data.status, 'done', JSON.stringify(again.data))
  })

  test('E48 delete open and closed sessions: opencode no longer lists them (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const open = String((await openSession(server(), env().work, 'opencode')).data.session)
    const closed = String((await openSession(server(), env().work, 'opencode')).data.session)
    await Promise.all([open, closed].map(session => promptIn(server(), session, OK_PROMPT)))
    await server().call('close', { session: closed })
    const ids = [open, closed].map(session => session.replace(/^opencode_/, ''))
    const listedBefore = await nativeSessions(env(), env().work)
    assert.ok(ids.every(id => listedBefore.includes(id)), `native sessions missing before delete: ${JSON.stringify(listedBefore)}`)
    await [open, closed].reduce(async (prev, session) => {
      await prev
      const deleted = await server().call('delete', { session })
      assert.equal(deleted.isError, false, JSON.stringify(deleted.data))
      assert.equal(deleted.data.native, 'deleted')
      assert.equal(await exists(join(env().home, 'sessions', session)), false)
    }, Promise.resolve())
    const listedAfter = await nativeSessions(env(), env().work)
    diagnostic(`E48 data files after delete: ${JSON.stringify((await dataFiles(env())).filter(f => !f.startsWith('log')))}`)
    assert.deepEqual(ids.filter(id => listedAfter.includes(id)), [])
  })

  test('E54 a question is answered and the reply uses the answer', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'opencode')).data.session)
    const asked = await promptIn(server(), session, COLOR_PROMPT)
    assert.equal(asked.data.status, 'question_needed', JSON.stringify(asked.data))
    const { question_id, content, word } = firstChoice(asked)
    const done = await server().call('answer', { session, question_id, content })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    assert.match(String(done.data.output), new RegExp(word, 'i'))
  })
})

test.describe('opencode e2e: processes and clients', () => {
  test('E49 SIGKILL of the MCP server leaves no opencode behind (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const env = await makeEnv()
    const server = await startServer(env.home)
    try {
      const session = String((await openSession(server, env.work, 'opencode')).data.session)
      await promptIn(server, session, OK_PROMPT)
      const serverPid = server.pid ?? assert.fail('no server pid')
      const opencode = childPids(serverPid)
      const descendants = opencode.flatMap(childPids)
      assert.ok(opencode.length > 0, `opencode ${opencode}`)
      process.kill(serverPid, 'SIGKILL')
      const gone = await until(() => [...opencode, ...descendants].every(p => !isAlive(p)), 10_000, 'opencode processes exit').then(() => true, () => false)
      diagnostic(`E49 opencode processes gone within 10s: ${gone} (opencode ${opencode.length}, descendants ${descendants.length})`)
      assert.ok(gone)
    } finally {
      await server.close().catch(() => undefined)
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E50 Codex CLI as the MCP client delegates to opencode', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!CODEX_PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const env = await makeEnv()
    const clientHome = join(env.root, 'client-codex-home')
    await mkdir(clientHome)
    await writeFile(join(clientHome, 'config.toml'), clientToml(await readFile(CODEX_PROVIDER_CONFIG ?? '', 'utf-8'), env.home, 300))
    try {
      const prompt = `Use the cockpit MCP server. Call its open tool with subagent "opencode" and cwd "${env.work}". Then call its prompt tool with the returned session and text "Reply with exactly PONG. Do not run any tools.". Finally print the output field you received.`
      const { code, text } = await codexExec(clientHome, env.work, prompt)
      assert.equal(code, 0, text.slice(-2000))
      assert.match(text.slice(text.lastIndexOf('cockpit/prompt')), /PONG/)
      const sessions = await readdir(join(env.home, 'sessions'))
      assert.deepEqual(sessions.map(s => s.split('_')[0]), ['opencode'])
    } finally {
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E51 two opencode sessions on the same data dir run at the same time (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const env = await makeEnv()
    const server = await startServer(env.home)
    try {
      // Opened one after the other: opencode 2.0.30 started twice at the same moment on a fresh data dir fails its
      // own standalone server ("exited before reporting readiness"). A failed open shows the agent's stderr
      const openOne = async () => {
        const opened = await server.call('open', { subagent: 'opencode', cwd: env.work })
        assert.equal(opened.isError, false, `${JSON.stringify(opened.data)}\n${server.stderr().slice(-3000)}`)
        return String(opened.data.session)
      }
      const sessions = [await openOne(), await openOne()]
      assert.equal(childPids(server.pid ?? assert.fail('no server pid')).length, 2)
      const tag = (i: number) => `OPENCODE-TWIN-${i}`
      const replies = await Promise.all(sessions.map((session, i) => promptIn(server, session, `Write the numbers 1 to 30 separated by spaces, then ${tag(i)} on its own line. Do not run any tools.`)))
      replies.forEach((r, i) => {
        assert.equal(r.data.status, 'done', JSON.stringify(r.data))
        assert.match(String(r.data.output), new RegExp(tag(i)))
        assert.doesNotMatch(String(r.data.output), new RegExp(tag(1 - i)))
      })
      const locked = /database is locked|SQLITE_BUSY|EADDRINUSE/i.test(server.stderr())
      diagnostic(`E51 lock or port errors on stderr: ${locked}`)
      assert.equal(locked, false, server.stderr().slice(-2000))
    } finally {
      await server.close().catch(() => undefined)
      await rm(env.root, { recursive: true, force: true })
    }
  })
})
