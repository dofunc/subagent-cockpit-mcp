// End-to-end tests against real codex-acp and codex. Not part of `npm test`.
//
// Provider: COCKPIT_E2E_CODEX_CONFIG names a codex config.toml (e.g. a custom provider whose
// env_key is set in the environment). It is copied into an isolated CODEX_HOME for every run.
// Without it, the local codex login (~/.codex) is used.
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { approvalId, baseEnv, childPids, clientToml, codexExec, COLOR_PROMPT, exists, firstChoice, openSession, promptIn, startServer, TURN_TIMEOUT } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { isAlive, until } from '../../fixtures/harness'
import type { ToolReply } from '../../fixtures/harness'
import { approvals, expectAnsweredTurn, sessionsOf, showLatest, startWatched } from '../../fixtures/page'
import type { Watched } from '../../fixtures/page'

/** A recorded observation, kept as an annotation in the report. */
const diagnostic = (description: string) => test.info().annotations.push({ type: 'diagnostic', description })

// The bundled copy, driving the local codex like the server does
const CODEX_ACP = fileURLToPath(new URL('../../../dist/codex-acp.js', import.meta.url))
const LOCAL_CODEX = execFileSync('which', ['codex'], { encoding: 'utf-8' }).trim()
const PROVIDER_CONFIG = process.env.COCKPIT_E2E_CODEX_CONFIG

interface Env {
  root: string
  home: string
  codexHome: string
  work: string
}

/** Isolated cockpit home and CODEX_HOME holding the provider config. */
async function makeEnv(subagentExtra: Record<string, object> = {}): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-e2e-'))
  const env = { root, home: join(root, 'home'), codexHome: join(root, 'codex-home'), work: join(root, 'work') }
  await Promise.all([mkdir(env.home), mkdir(env.codexHome), mkdir(env.work)])
  PROVIDER_CONFIG && await copyFile(PROVIDER_CONFIG, join(env.codexHome, 'config.toml'))
  const codexEnv = PROVIDER_CONFIG ? { CODEX_HOME: env.codexHome } : {}
  const sub = (extra: object = {}) => ({ adapter: 'codex', reasoning_effort: 'low', env: codexEnv, ...extra })
  await writeFile(join(env.home, 'config.json'), JSON.stringify({
    idle: { timeout: 0 },
    webui: { port: 0 },
    subagents: {
      codex: sub(),
      ro: sub({ mode: 'read-only' }),
      ...Object.fromEntries(Object.entries(subagentExtra).map(([name, extra]) => [name, sub(extra)])),
    },
  }))
  return env
}

test.describe('codex e2e', () => {
  // Later cases build on the sessions of earlier ones
  test.describe.configure({ mode: 'serial' })
  const ctx: { env?: Env; server?: Server; watched?: Watched; session?: string } = {}
  const server = () => ctx.server ?? assert.fail('server not started')
  const page = () => ctx.watched?.page ?? assert.fail('page not open')
  const env = () => ctx.env ?? assert.fail('env not ready')

  test.beforeAll(async ({ browser }) => {
    ctx.env = await makeEnv()
    // E69: the group's webui stays open in the browser throughout
    ctx.watched = await startWatched(browser, ctx.env.home)
    ctx.server = ctx.watched.server
  })

  test.afterAll(async () => {
    await ctx.watched?.close()
    ctx.env && await rm(ctx.env.root, { recursive: true, force: true })
  })

  test('E1 a read-only task completes', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'codex')).data.session)
    const r = await promptIn(server(), session, 'Reply with exactly the word PONG. Do not run any tools.')
    assert.equal(r.isError, false, JSON.stringify(r.data))
    assert.equal(r.data.status, 'done')
    assert.match(String(r.data.output), /PONG/)
    ctx.session = session
    assert.ok(await exists(join(env().home, 'sessions', ctx.session, 'session.json')))
    await expectAnsweredTurn(page(), 'codex', /Reply with exactly the word PONG/, /^PONG\.?$/)
  })

  const touchPrompt = (file: string) => `Create an empty file named ${file} in the current directory by running the shell command \`touch ${file}\`. If the sandbox blocks it, request approval to run it with escalated permissions. Then reply DONE.`

  async function askForApproval(file: string): Promise<{ session: string; reply: ToolReply }> {
    const session = String((await openSession(server(), env().work, 'ro')).data.session)
    const reply = await promptIn(server(), session, touchPrompt(file))
    assert.equal(reply.data.status, 'approval_needed', `expected an approval, got ${JSON.stringify(reply.data)}`)
    return { session, reply }
  }

  test('E2 approve a command', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const { session, reply } = await askForApproval('approved.txt')
    const conversation = await showLatest(page(), 'ro')
    await expect(approvals(conversation).first()).toContainText('waiting for an answer')
    const done = await server().call('approve', { session, approval_id: approvalId(reply) })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    await expect(approvals(conversation).first()).toContainText('approved once')
    assert.ok(await exists(join(env().work, 'approved.txt')))
  })

  test('E3 allow: the same kind of command is not asked again in this session, and nothing persists', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const { session, reply } = await askForApproval('allowed-1.txt')
    await server().call('allow', { session, approval_id: approvalId(reply) })
    const second = await promptIn(server(), session, touchPrompt('allowed-1.txt'))
    diagnostic(`E3 same command again: ${second.data.status}`)
    second.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(second) })
    assert.equal(second.data.status, 'done', JSON.stringify(second.data))
    const rules = await readFile(join(env().codexHome, 'rules', 'default.rules'), 'utf-8').catch(() => '')
    assert.doesNotMatch(rules, /touch/)
  })

  test('E4 reject: the task continues with another reply', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const { session, reply } = await askForApproval('rejected.txt')
    const done = await server().call('reject', { session, approval_id: approvalId(reply) })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    assert.ok(String(done.data.output).length > 0)
    assert.equal(await exists(join(env().work, 'rejected.txt')), false)
  })

  test('E5 cancel a long task', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'codex')).data.session)
    await server().call('prompt', { session, text: 'Run the shell command `sleep 120`, then reply FINISHED.', wait: false })
    await new Promise(resolve => setTimeout(resolve, 8000))
    const cancelled = await server().call('cancel', { session })
    assert.ok(['cancelling', 'done'].includes(String(cancelled.data.status)))
    const deadline = Date.now() + 60_000
    const idle = async (): Promise<boolean> => (await server().call('status', { session })).data.state === 'IDLE'
    while (!(await idle())) {
      assert.ok(Date.now() < deadline, 'cancel did not finish within 60s')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  })

  test('E6 change model and reasoning_effort', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = ctx.session ?? assert.fail('E1 session missing')
    const snapshot = await server().call('snapshot', {})
    const sessions = snapshot.data.sessions as Array<{ session: string; config_options: Array<{ id: string; current_value: string; options: Array<{ value: string }> }> }>
    const model = sessions.find(s => s.session === session)?.config_options.find(c => c.id === 'model')
    const target = model?.options.map(o => o.value).find(v => v !== model.current_value) ?? assert.fail('no alternative model')
    await server().call('set_config', { session, config_id: 'model', value: target })
    await server().call('set_config', { session, config_id: 'reasoning_effort', value: 'medium' })
    const config = (await server().call('status', { session })).data.config as Record<string, string>
    assert.equal(config.model, target)
    assert.equal(config.reasoning_effort, 'medium')
  })

  test('E7 close and reconnect replays history into snapshot events', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = ctx.session ?? assert.fail('E1 session missing')
    await server().call('close', { session })
    await expect(sessionsOf(page(), 'codex').filter({ hasText: 'CLOSED' })).toHaveCount(1)
    const reopened = await server().call('open', { subagent: 'codex', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const snapshot = await server().call('snapshot', {})
    const sessions = snapshot.data.sessions as Array<{ session: string; events: Array<{ replay: boolean; text?: string }> }>
    const replayed = sessions.find(s => s.session === session)?.events.filter(e => e.replay) ?? []
    assert.ok(replayed.some(e => /PONG/.test(e.text ?? '')), 'replayed events should include the earlier reply')
  })

  test('E11 mode read-only: writing asks for approval or is refused (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'codex')).data.session)
    await server().call('set_config', { session, config_id: 'mode', value: 'read-only' })
    const r = await promptIn(server(), session, 'Write the text hello into a new file mode-check.txt in the current directory, then reply DONE.')
    diagnostic(`E11 status: ${r.data.status}; file created: ${await exists(join(env().work, 'mode-check.txt'))}`)
    r.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(r) })
    assert.ok(r.data.status === 'approval_needed' || !(await exists(join(env().work, 'mode-check.txt'))))
  })

  test('E12 delete archives the native session (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'codex')).data.session)
    await promptIn(server(), session, 'Reply with exactly OK.')
    const nativeId = session.replace(/^codex_/, '')
    const deleted = await server().call('delete', { session })
    assert.equal(deleted.isError, false, JSON.stringify(deleted.data))
    assert.equal(deleted.data.native, 'archived')
    assert.equal(await exists(join(env().home, 'sessions', session)), false)
    if (!PROVIDER_CONFIG) return
    const archived = await readdir(join(env().codexHome, 'archived_sessions'), { recursive: true }).catch(() => [])
    const live = await readdir(join(env().codexHome, 'sessions'), { recursive: true }).catch(() => [])
    diagnostic(`E12 archived rollout: ${archived.some(f => String(f).includes(nativeId))}; still in sessions: ${live.some(f => String(f).includes(nativeId))}`)
    assert.ok(archived.some(f => String(f).includes(nativeId)))
    assert.ok(!live.some(f => String(f).includes(nativeId)))
  })

  test('E53 a question in plan collaboration mode is answered; the default mode is recorded', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const plain = String((await openSession(server(), env().work, 'codex')).data.session)
    const unasked = await promptIn(server(), plain, COLOR_PROMPT)
    diagnostic(`E53 default collaboration mode: ${unasked.data.status}`)
    unasked.data.status === 'question_needed' && await server().call('answer', { session: plain, question_id: firstChoice(unasked).question_id, action: 'cancel' })

    const session = String((await openSession(server(), env().work, 'codex')).data.session)
    const set = await server().call('set_config', { session, config_id: 'collaboration_mode', value: 'plan' })
    assert.equal(set.isError, false, JSON.stringify(set.data))
    const asked = await promptIn(server(), session, COLOR_PROMPT)
    assert.equal(asked.data.status, 'question_needed', JSON.stringify(asked.data))
    const { question_id, content, word } = firstChoice(asked)
    const done = await server().call('answer', { session, question_id, content })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    assert.match(String(done.data.output), new RegExp(word, 'i'))
  })
})

test.describe('codex e2e: processes and providers', () => {
  test('E8 SIGKILL of the MCP server leaves no codex-acp or app-server behind (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const env = await makeEnv()
    const server = await startServer(env.home)
    try {
      await openSession(server, env.work, 'codex')
      const serverPid = server.pid ?? assert.fail('no server pid')
      const acp = childPids(serverPid)
      const appServers = acp.flatMap(childPids)
      assert.ok(acp.length > 0 && appServers.length > 0, `acp ${acp} app-server ${appServers}`)
      process.kill(serverPid, 'SIGKILL')
      const gone = await until(() => [...acp, ...appServers].every(p => !isAlive(p)), 10_000, 'agent processes exit').then(() => true, () => false)
      diagnostic(`E8 agent processes gone within 10s: ${gone}`)
      assert.ok(gone)
    } finally {
      await server.close().catch(() => undefined)
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E10 custom provider via CODEX_HOME config.toml and via CODEX_CONFIG + MODEL_PROVIDER (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const toml = await readFile(PROVIDER_CONFIG ?? '', 'utf-8')
    const provider = /^model_provider\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? assert.fail('model_provider missing')
    const field = (name: string) => new RegExp(`\\[model_providers\\.${provider}\\][^[]*?${name}\\s*=\\s*"([^"]+)"`, 's').exec(toml)?.[1]
    const model = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
    const bare = await mkdtemp(join(tmpdir(), 'cockpit-e2e-bare-'))
    const codexConfig = {
      model,
      model_provider: provider,
      model_providers: { [provider]: { name: provider, base_url: field('base_url'), env_key: field('env_key'), wire_api: field('wire_api') ?? 'responses', requires_openai_auth: false } },
    }
    const env = await makeEnv({ injected: { env: { CODEX_HOME: bare, CODEX_CONFIG: JSON.stringify(codexConfig), MODEL_PROVIDER: provider } } })
    const server = await startServer(env.home)
    try {
      const results = await Promise.all(['codex', 'injected'].map(async subagent => {
        const opened = await server.call('open', { subagent, cwd: env.work })
        const r = opened.isError ? opened : await promptIn(server, String(opened.data.session), 'Reply with exactly PONG. Do not run any tools.')
        return [subagent, r] as const
      }))
      results.forEach(([subagent, r]) => diagnostic(`E10 ${subagent}: ${r.isError ? JSON.stringify(r.data) : r.data.output}`))
      // Only the CODEX_HOME config.toml route is supported; the injected route is recorded, not required
      const [[, viaHome]] = results
      assert.match(String(viaHome.data.output), /PONG/, JSON.stringify(viaHome.data))
      assert.equal(await exists(join(env.codexHome, 'auth.json')), false)
      assert.equal(await exists(join(bare, 'auth.json')), false)
    } finally {
      await server.close()
      await rm(env.root, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  })

  test('E9 Codex CLI as the MCP client delegates a read-only task', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const env = await makeEnv()
    const clientHome = join(env.root, 'client-codex-home')
    await mkdir(clientHome)
    await writeFile(join(clientHome, 'config.toml'), clientToml(await readFile(PROVIDER_CONFIG ?? '', 'utf-8'), env.home, 120))
    try {
      const prompt = `Use the cockpit MCP server. Call its open tool with subagent "codex" and cwd "${env.work}". Then call its prompt tool with the returned session and text "Reply with exactly PONG. Do not run any tools.". Finally print the output field you received.`
      const { code, text } = await codexExec(clientHome, env.work, prompt)
      assert.equal(code, 0, text.slice(-2000))
      assert.match(text, /PONG/)
      assert.doesNotMatch(text, /timed out/i)
      const sessions = await readdir(join(env.home, 'sessions'))
      assert.equal(sessions.length, 1)
    } finally {
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E13 Codex CLI recovers the result with status and output after its tool call times out', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const env = await makeEnv({ full: { mode: 'agent-full-access' } })
    const clientHome = join(env.root, 'client-codex-home')
    await mkdir(clientHome)
    await writeFile(join(clientHome, 'config.toml'), clientToml(await readFile(PROVIDER_CONFIG ?? '', 'utf-8'), env.home, 30))
    try {
      const prompt = [
        'Use the cockpit MCP server.',
        `Step 1: call its open tool with subagent "full" and cwd "${env.work}".`,
        'Step 2: call its prompt tool with the returned session and text "Run the shell command sleep 75, then reply with exactly SLEPT.".',
        'Step 3: if the prompt call fails or times out, do NOT call prompt again; call the status tool with the same session, and while its state is RUNNING run the shell command sleep 15 and call status again.',
        'Step 4: once the state is IDLE, call the output tool and print its output field.',
      ].join(' ')
      const { code, text } = await codexExec(clientHome, env.work, prompt)
      diagnostic(`E13 client saw a timeout: ${/timed out/i.test(text)}`)
      assert.equal(code, 0, text.slice(-2000))
      assert.match(text, /timed out/i)
      assert.match(text, /cockpit\/status/)
      // The prompt itself is echoed in the log, so look for the reply after the output call only
      assert.match(text.slice(text.lastIndexOf('cockpit/output')), /SLEPT/)
      // status only answers sessions held in memory, so the same server process served the whole run
      assert.equal((await readdir(join(env.home, 'sessions'))).length, 1)
    } finally {
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('api-key authentication through codex-acp writes auth.json (recorded)', async () => {
    test.setTimeout(120_000)
    const codexHome = await mkdtemp(join(tmpdir(), 'cockpit-e2e-auth-'))
    const child = spawn(process.execPath, [CODEX_ACP], { env: { ...baseEnv(), CODEX_HOME: codexHome, CODEX_PATH: LOCAL_CODEX }, stdio: ['pipe', 'pipe', 'ignore'] })
    try {
      const input = new ReadableStream<Uint8Array>({ start(c) { child.stdout.on('data', (b: Buffer) => c.enqueue(new Uint8Array(b))) } })
      const output = new WritableStream<Uint8Array>({ write(chunk) { child.stdin.write(chunk) } })
      const conn = new ClientSideConnection(() => ({ requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate: async () => {} }), ndJsonStream(output, input))
      await conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
      const result = await conn.authenticate({ methodId: 'api-key', _meta: { 'api-key': { apiKey: 'sk-cockpit-e2e-dummy' } } }).then(() => 'ok', (err: Error) => `error: ${err.message}`)
      const written = await exists(join(codexHome, 'auth.json'))
      diagnostic(`api-key authenticate: ${result}; auth.json written: ${written}`)
    } finally {
      child.kill()
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
