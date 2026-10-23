// End-to-end tests against the local pi through the bundled bridge dist/pi-acp.js. Not part of `npm test`.
//
// Provider: COCKPIT_E2E_PI_MODELS names a pi models.json (e.g. a gateway whose apiKey is `${OPENAI_API_KEY}`) and
// COCKPIT_E2E_PI_MODEL the model as provider/id. Every run copies the models.json into a temporary
// PI_CODING_AGENT_DIR, so pi reads neither the local pi config nor its login; the key comes from the environment.
// Without COCKPIT_E2E_PI_MODELS the local pi config and login are used as they are. Sessions always go to a temporary
// PI_CODING_AGENT_SESSION_DIR, and the subagents pass --no-skills, --no-extensions and --no-mcp, so local skills and
// extensions do not change the results. This isolation belongs to the tests only; the product passes the subagent
// env and args through untouched. No address or credential is written in this file. The suite is skipped when pi is
// not installed.
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childPids, clientToml, codexExec, COLOR_PROMPT, exists, itemText, openSession, promptIn, replayed, snapshotItems, startServer, TURN_TIMEOUT } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { isAlive, sleep, until } from '../../fixtures/harness'
import type { ToolReply } from '../../fixtures/harness'
import { expectAnsweredTurn, sessionsOf, showLatest, startWatched, turnEnd } from '../../fixtures/page'
import type { Watched } from '../../fixtures/page'

/** A recorded observation, kept as an annotation in the report. */
const diagnostic = (description: string) => test.info().annotations.push({ type: 'diagnostic', description })

const PI_MODELS = process.env.COCKPIT_E2E_PI_MODELS
const MODEL = process.env.COCKPIT_E2E_PI_MODEL ?? ''
const CODEX_PROVIDER_CONFIG = process.env.COCKPIT_E2E_CODEX_CONFIG
const NOTE = 'PELICAN-4711'
const WORD = 'MARMALADE'
const ARGS = ['--no-skills', '--no-extensions', '--no-mcp']

const UNAVAILABLE = (() => {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v pi'], { encoding: 'utf-8' }).trim() ? false : 'pi is not installed'
  } catch {
    return 'pi is not installed'
  }
})()

interface Env {
  root: string
  home: string
  work: string
  /** Where pi keeps the sessions of this run */
  sessions: string
}

interface ConfigOption {
  id: string
  current_value: string
}

/** Isolated cockpit home, work dir and pi session dir; with COCKPIT_E2E_PI_MODELS also pi's own config dir. */
async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-e2e-pi-'))
  const dir = (name: string) => join(root, name)
  await Promise.all(['home', 'work', 'pi-sessions', ...(PI_MODELS ? ['pi-agent'] : [])].map(name => mkdir(dir(name))))
  await writeFile(join(dir('work'), 'note.txt'), `${NOTE}\n`)
  PI_MODELS && await copyFile(PI_MODELS, join(dir('pi-agent'), 'models.json'))
  const agentEnv = {
    PI_CODING_AGENT_SESSION_DIR: dir('pi-sessions'),
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    ...(PI_MODELS ? { PI_CODING_AGENT_DIR: dir('pi-agent') } : {}),
  }
  const sub = (extra: object = {}) => ({ adapter: 'pi', profile: 'px', args: ARGS, ...(MODEL ? { model: MODEL } : {}), ...extra })
  await writeFile(join(dir('home'), 'config.json'), JSON.stringify({
    idle: { timeout: 0 },
    webui: { port: 0 },
    profiles: { px: { env: agentEnv } },
    subagents: {
      pi: sub(),
      tuned: sub({ reasoning_effort: 'low' }),
    },
  }))
  return { root, home: dir('home'), work: dir('work'), sessions: dir('pi-sessions') }
}

const OK_PROMPT = 'Reply with exactly OK. Do not run any tools.'
const configOf = (reply: ToolReply, id: string) => (reply.data.config_options as ConfigOption[]).find(o => o.id === id)
const nativeId = (session: string) => session.replace(/^pi_/, '')
/** pi's session files of this run that belong to the session */
const sessionFiles = async (env: Env, session: string) => (await readdir(env.sessions, { recursive: true })).map(String).filter(f => f.includes(nativeId(session)) && f.endsWith('.jsonl'))

test.describe('pi e2e', () => {
  // Later cases build on the sessions of earlier ones
  test.describe.configure({ mode: 'serial' })
  test.skip(Boolean(UNAVAILABLE), String(UNAVAILABLE))
  const ctx: { env?: Env; server?: Server; watched?: Watched } = {}
  const server = () => ctx.server ?? assert.fail('server not started')
  const page = () => ctx.watched?.page ?? assert.fail('page not open')
  const env = () => ctx.env ?? assert.fail('env not ready')
  const tools = async (session: string) => (await snapshotItems(server(), session)).filter(item => item.kind === 'tool')

  test.beforeAll(async ({ browser }) => {
    ctx.env = await makeEnv()
    // E84: the group's webui stays open in the browser throughout
    ctx.watched = await startWatched(browser, ctx.env.home)
    ctx.server = ctx.watched.server
  })

  test.afterAll(async () => {
    await ctx.watched?.close()
    ctx.env && await rm(ctx.env.root, { recursive: true, force: true })
  })

  test('E74 a read-only task completes with a read tool call', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'pi')).data.session)
    assert.match(session, /^pi_/)
    const r = await promptIn(server(), session, 'Read the file note.txt in the current directory with the read tool and reply with its exact content only. Do not modify anything.')
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
    assert.match(String(r.data.output), new RegExp(NOTE))
    const calls = (await tools(session)).map(({ data }) => ({ title: data.title, kind: data.kind, status: data.status }))
    diagnostic(`E74 tool calls: ${JSON.stringify(calls)}`)
    assert.ok(calls.some(c => c.kind === 'read'), JSON.stringify(calls))
    await expectAnsweredTurn(page(), 'pi', /Read the file note\.txt/, new RegExp(NOTE))
  })

  test('E75 write and edit run without approvals and come back as diffs', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'pi')).data.session)
    const r = await promptIn(server(), session, 'Create a file named hello.txt containing the single line alpha, using the write tool. Then replace alpha with beta in it, using the edit tool. Then reply DONE.')
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
    assert.equal((await readFile(join(env().work, 'hello.txt'), 'utf-8')).trim(), 'beta')
    const diffs = (await tools(session)).filter(item => item.data.kind === 'edit').flatMap(item => (Array.isArray(item.data.content) ? item.data.content : []))
      .map(block => JSON.parse(JSON.stringify(block)))
      .filter(block => block.type === 'diff')
    diagnostic(`E75 diffs: ${JSON.stringify(diffs.map(d => ({ oldText: d.oldText, newText: d.newText })))}`)
    assert.ok(diffs.some(d => d.oldText === null && String(d.newText).includes('alpha')), JSON.stringify(diffs))
    assert.ok(diffs.some(d => String(d.oldText).includes('alpha') && String(d.newText).includes('beta')), JSON.stringify(diffs))
  })

  test('E76 cancel a running command; the conversation goes on', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'pi')).data.session)
    await promptIn(server(), session, `Remember the word ${WORD}. Reply with exactly OK. Do not run any tools.`)
    const pending = promptIn(server(), session, 'Run exactly the shell command `sleep 30 && echo late` with the bash tool, then reply with its output.')
    await until(async () => (await tools(session)).some(item => item.data.kind === 'execute'), 180_000, 'bash starts')
    await server().call('cancel', { session })
    const r = await pending
    assert.deepEqual([r.data.status, r.data.outcome], ['done', 'cancelled'], JSON.stringify(r.data))
    assert.doesNotMatch(String(r.data.output ?? ''), /late/)
    assert.equal((await server().call('status', { session })).data.state, 'IDLE')
    await expect(turnEnd(await showLatest(page(), 'pi'), 'cancelled')).toBeVisible()
    const next = await promptIn(server(), session, 'Which word did I ask you to remember? Reply with the word only.')
    assert.equal(next.data.status, 'done', JSON.stringify(next.data))
    assert.match(String(next.data.output), new RegExp(WORD, 'i'))
  })

  test('E77 initial config, then set_config; the next turn runs on it', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'tuned')
    diagnostic(`E77 config_options size: ${JSON.stringify(opened.data.config_options).length} characters`)
    MODEL && assert.equal(configOf(opened, 'model')?.current_value, MODEL)
    assert.equal(configOf(opened, 'reasoning_effort')?.current_value, 'low')
    const session = String(opened.data.session)
    const effort = await server().call('set_config', { session, config_id: 'reasoning_effort', value: 'medium' })
    assert.equal(effort.isError, false, JSON.stringify(effort.data))
    const config = (await server().call('status', { session })).data.config as Record<string, string>
    assert.equal(config.reasoning_effort, 'medium')
    const r = await promptIn(server(), session, OK_PROMPT)
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
  })

  test('E78 close and reconnect: the history is replayed and the conversation continues', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'pi')).data.session)
    await promptIn(server(), session, `Remember the word ${WORD}. Reply with exactly OK. Do not run any tools.`)
    await server().call('close', { session })
    await expect(sessionsOf(page(), 'pi').filter({ hasText: 'CLOSED' }).first()).toBeVisible()
    const reopened = await server().call('open', { subagent: 'pi', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const replay = replayed(await snapshotItems(server(), session))
    diagnostic(`E78 replayed: ${JSON.stringify(replay.map(item => [item.kind, itemText(item).slice(0, 60)]))}`)
    assert.ok(replay.some(item => item.kind === 'user_message' && itemText(item).includes(WORD)), JSON.stringify(replay.map(i => i.kind)))
    await expect((await showLatest(page(), 'pi')).getByText(new RegExp(`Remember the word ${WORD}`)).first()).toBeVisible()
    const r = await promptIn(server(), session, 'Which word did I ask you to remember? Reply with the word only.')
    assert.match(String(r.data.output), new RegExp(WORD, 'i'))
  })

  test('E79 delete open and closed sessions: deleted natively, pi files gone and not written back', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const open = String((await openSession(server(), env().work, 'pi')).data.session)
    const closed = String((await openSession(server(), env().work, 'pi')).data.session)
    await Promise.all([open, closed].map(session => promptIn(server(), session, OK_PROMPT)))
    await server().call('close', { session: closed })
    assert.deepEqual(await Promise.all([open, closed].map(async s => (await sessionFiles(env(), s)).length)), [1, 1])
    await [open, closed].reduce(async (prev, session) => {
      await prev
      const deleted = await server().call('delete', { session })
      assert.equal(deleted.isError, false, JSON.stringify(deleted.data))
      assert.equal(deleted.data.native, 'deleted')
      assert.equal(await exists(join(env().home, 'sessions', session)), false)
    }, Promise.resolve())
    await sleep(3000)
    assert.deepEqual(await Promise.all([open, closed].map(async s => (await sessionFiles(env(), s)).length)), [0, 0])
  })

  test('E82 usage and commands after a turn (commands recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'pi')).data.session)
    await promptIn(server(), session, OK_PROMPT)
    const progress = (await server().call('progress', { session })).data
    const usage = progress.usage as { used: number; size: number } | null
    diagnostic(`E82 usage ${JSON.stringify(usage)}, ${Array.isArray(progress.commands) ? progress.commands.length : 0} commands`)
    assert.ok(usage && usage.size > 0 && usage.used > 0, JSON.stringify(usage))
  })

  test('E83 a question is not asked over ACP, never question_needed (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'pi')).data.session)
    const r = await promptIn(server(), session, COLOR_PROMPT)
    diagnostic(`E83 reply: ${JSON.stringify(r.data.output)}`)
    assert.equal(r.data.status, 'done', JSON.stringify(r.data))
  })
})

test.describe('pi e2e: processes and clients', () => {
  test.skip(Boolean(UNAVAILABLE), String(UNAVAILABLE))
  test('E80 SIGKILL of the MCP server during a turn leaves no bridge or pi behind (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const env = await makeEnv()
    const server = await startServer(env.home)
    try {
      const session = String((await openSession(server, env.work, 'pi')).data.session)
      await server.call('prompt', { session, text: 'Run exactly the shell command `sleep 30` with the bash tool, then reply DONE.', wait: false })
      await until(async () => (await snapshotItems(server, session)).some(item => item.kind === 'tool'), 180_000, 'bash starts')
      const serverPid = server.pid ?? assert.fail('no server pid')
      const bridges = childPids(serverPid)
      const pi = bridges.flatMap(childPids)
      const descendants = pi.flatMap(childPids)
      assert.ok(bridges.length > 0 && pi.length > 0, `bridge ${bridges}, pi ${pi}`)
      process.kill(serverPid, 'SIGKILL')
      const all = [...bridges, ...pi, ...descendants]
      const gone = await until(() => all.every(p => !isAlive(p)), 10_000, 'bridge and pi exit').then(() => true, () => false)
      diagnostic(`E80 gone within 10s: ${gone} (bridge ${bridges.length}, pi ${pi.length}, descendants ${descendants.length}); alive: ${all.filter(isAlive)}`)
      assert.ok(gone)
    } finally {
      await server.close().catch(() => undefined)
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E81 Codex CLI as the MCP client delegates to Pi', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!CODEX_PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const env = await makeEnv()
    const clientHome = join(env.root, 'client-codex-home')
    await mkdir(clientHome)
    await writeFile(join(clientHome, 'config.toml'), clientToml(await readFile(CODEX_PROVIDER_CONFIG ?? '', 'utf-8'), env.home, 300, ['OPENAI_API_KEY', 'HOME']))
    try {
      const prompt = `Use the cockpit MCP server. Call its open tool with subagent "pi" and cwd "${env.work}". Then call its prompt tool with the returned session and text "Reply with exactly PONG. Do not run any tools.". Finally print the output field you received.`
      const { code, text } = await codexExec(clientHome, env.work, prompt)
      assert.equal(code, 0, text.slice(-2000))
      assert.match(text.slice(text.lastIndexOf('cockpit/prompt')), /PONG/)
      const sessions = await readdir(join(env.home, 'sessions'))
      assert.deepEqual(sessions.map(s => s.split('_')[0]), ['pi'])
    } finally {
      await rm(env.root, { recursive: true, force: true })
    }
  })
})
