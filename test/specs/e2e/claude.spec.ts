// End-to-end tests against the bundled claude-agent-acp and the local claude. Not part of `npm test`.
//
// Provider: when ANTHROPIC_BASE_URL is set, every subagent gets a temporary CLAUDE_CONFIG_DIR and takes
// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment through a shared profile; the
// inherited CLAUDE_CODE_OAUTH_TOKEN is dropped so the gateway is used. Without it, the local claude
// login is used. No address or credential is written in this file.
import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalId, childPids, clientToml, codexExec, COLOR_PROMPT, exists, firstChoice, itemText, openSession, promptIn, replayed, snapshotItems, startServer, TURN_TIMEOUT } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { isAlive, until } from '../../fixtures/harness'
import type { ToolReply } from '../../fixtures/harness'
import { approvals, expectAnsweredTurn, sessionsOf, showLatest, startWatched } from '../../fixtures/page'
import type { Watched } from '../../fixtures/page'

/** A recorded observation, kept as an annotation in the report. */
const diagnostic = (description: string) => test.info().annotations.push({ type: 'diagnostic', description })

const GATEWAY = Boolean(process.env.ANTHROPIC_BASE_URL)
const CODEX_PROVIDER_CONFIG = process.env.COCKPIT_E2E_CODEX_CONFIG
const ZEBRA_ARGS = ['--append-system-prompt', 'End every reply with the word ZEBRA.']

interface Env {
  root: string
  home: string
  claudeConfig: string
  work: string
}

interface ConfigOption {
  id: string
  current_value: string
  options: Array<{ value: string }>
}

/** Isolated cockpit home, CLAUDE_CONFIG_DIR and work dir; subagents share the `gw` profile. */
async function makeEnv(subagents: Record<string, object> = {}): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-e2e-claude-'))
  const env = { root, home: join(root, 'home'), claudeConfig: join(root, 'claude-config'), work: join(root, 'work') }
  await Promise.all([mkdir(env.home), mkdir(env.claudeConfig), mkdir(env.work)])
  const gw = GATEWAY
    ? {
      env: {
        CLAUDE_CONFIG_DIR: env.claudeConfig,
        ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}',
        ANTHROPIC_AUTH_TOKEN: '${ANTHROPIC_AUTH_TOKEN}',
        CLAUDE_CODE_OAUTH_TOKEN: '',
      },
    }
    : {}
  const sub = (extra: object = {}) => ({ adapter: 'claude', profile: 'gw', mode: 'default', ...extra })
  await writeFile(join(env.home, 'config.json'), JSON.stringify({
    idle: { timeout: 0 },
    webui: { port: 0 },
    profiles: { gw },
    subagents: {
      claude: sub(),
      plan: sub({ mode: 'plan' }),
      zebra: sub({ args: ZEBRA_ARGS }),
      ...Object.fromEntries(Object.entries(subagents).map(([name, extra]) => [name, sub(extra)])),
    },
  }))
  return env
}

const touchPrompt = (file: string) => `Run exactly the shell command \`touch ${file}\` in the current directory, even if the file already exists. Then reply DONE.`

test.describe('claude e2e', () => {
  // Later cases build on the sessions of earlier ones
  test.describe.configure({ mode: 'serial' })
  const ctx: { env?: Env; server?: Server; watched?: Watched; session?: string } = {}
  const server = () => ctx.server ?? assert.fail('server not started')
  const page = () => ctx.watched?.page ?? assert.fail('page not open')
  const env = () => ctx.env ?? assert.fail('env not ready')
  const configOf = (reply: ToolReply, id: string) => (reply.data.config_options as ConfigOption[]).find(o => o.id === id)

  test.beforeAll(async ({ browser }) => {
    ctx.env = await makeEnv()
    // E70: the group's webui stays open in the browser throughout
    ctx.watched = await startWatched(browser, ctx.env.home)
    ctx.server = ctx.watched.server
  })

  test.afterAll(async () => {
    await ctx.watched?.close()
    ctx.env && await rm(ctx.env.root, { recursive: true, force: true })
  })

  test('E14 a read-only task completes', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'claude')
    const session = String(opened.data.session)
    assert.match(session, /^claude_/)
    const r = await promptIn(server(), session, 'Reply with exactly the word PONG. Do not run any tools.')
    assert.equal(r.isError, false, JSON.stringify(r.data))
    assert.equal(r.data.status, 'done')
    assert.match(String(r.data.output), /PONG/)
    ctx.session = session
    await expectAnsweredTurn(page(), 'claude', /Reply with exactly the word PONG/, /^PONG\.?$/)
  })

  async function askForApproval(file: string): Promise<{ session: string; reply: ToolReply }> {
    const session = String((await openSession(server(), env().work, 'claude')).data.session)
    const reply = await promptIn(server(), session, touchPrompt(file))
    assert.equal(reply.data.status, 'approval_needed', `expected an approval, got ${JSON.stringify(reply.data)}`)
    return { session, reply }
  }

  test('E15 approve a command', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const { session, reply } = await askForApproval('approved.txt')
    const conversation = await showLatest(page(), 'claude')
    await expect(approvals(conversation).first()).toContainText('waiting for an answer')
    const done = await server().call('approve', { session, approval_id: approvalId(reply) })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    await expect(approvals(conversation).first()).toContainText('approved once')
    assert.ok(await exists(join(env().work, 'approved.txt')))
  })

  test('E16 allow: the same command is not asked again, and no settings are written (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const { session, reply } = await askForApproval('allowed-1.txt')
    const first = await server().call('allow', { session, approval_id: approvalId(reply) })
    assert.equal(first.data.status, 'done', JSON.stringify(first.data))
    const second = await promptIn(server(), session, touchPrompt('allowed-1.txt'))
    diagnostic(`E16 same command again: ${second.data.status}`)
    second.data.status === 'approval_needed' && await server().call('reject', { session, approval_id: approvalId(second) })
    assert.equal(second.data.status, 'done', JSON.stringify(second.data))
    const local = await readFile(join(env().work, '.claude', 'settings.local.json'), 'utf-8').catch(() => '')
    const user = await readFile(join(env().claudeConfig, 'settings.json'), 'utf-8').catch(() => '')
    diagnostic(`E16 settings.local.json: ${local ? 'present' : 'absent'}; config settings.json: ${user ? 'present' : 'absent'}`)
    assert.doesNotMatch(local, /touch/)
    assert.doesNotMatch(user, /touch/)
  })

  test('E17 reject: the task continues with another reply', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const { session, reply } = await askForApproval('rejected.txt')
    const done = await server().call('reject', { session, approval_id: approvalId(reply) })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    assert.ok(String(done.data.output).length > 0)
    assert.equal(await exists(join(env().work, 'rejected.txt')), false)
  })

  test('E18 cancel a long task', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'claude')).data.session)
    await server().call('prompt', { session, text: 'Run the shell command `sleep 120`, then reply FINISHED.', wait: false })
    await new Promise(resolve => setTimeout(resolve, 8000))
    const cancelled = await server().call('cancel', { session })
    assert.ok(['cancelling', 'done'].includes(String(cancelled.data.status)))
    await until(async () => (await server().call('status', { session })).data.state === 'IDLE', 60_000, 'cancel finished')
  })

  test('E19 initial mode from the subagent config, then set_config model and mode', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const opened = await openSession(server(), env().work, 'plan')
    assert.equal(configOf(opened, 'mode')?.current_value, 'plan')
    const session = String(opened.data.session)
    const model = configOf(opened, 'model') ?? assert.fail('no model option')
    const target = model.options.map(o => o.value).find(v => v !== model.current_value) ?? assert.fail('no alternative model')
    await server().call('set_config', { session, config_id: 'model', value: target })
    await server().call('set_config', { session, config_id: 'mode', value: 'default' })
    const config = (await server().call('status', { session })).data.config as Record<string, string>
    assert.deepEqual([config.model, config.mode], [target, 'default'])
  })

  test('E20 close and reconnect: history replays and the conversation continues', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = ctx.session ?? assert.fail('E14 session missing')
    await server().call('close', { session })
    await expect(sessionsOf(page(), 'claude').filter({ hasText: 'CLOSED' })).toHaveCount(1)
    const reopened = await server().call('open', { subagent: 'claude', cwd: env().work, session })
    assert.equal(reopened.isError, false, JSON.stringify(reopened.data))
    const history = replayed(await snapshotItems(server(), session))
    assert.ok(history.some(item => /PONG/.test(itemText(item))), 'the replayed history should include the earlier reply')
    const r = await promptIn(server(), session, 'Which single word did you reply with earlier? Answer with just that word.')
    assert.match(String(r.data.output), /PONG/)
  })

  test('E21 args reach claude, also after a reconnect (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'zebra')).data.session)
    const first = await promptIn(server(), session, 'Say hello in one short sentence.')
    assert.match(String(first.data.output).trim(), /ZEBRA\W*$/, String(first.data.output))
    await server().call('close', { session })
    await server().call('open', { subagent: 'zebra', cwd: env().work, session })
    const again = await promptIn(server(), session, 'Say goodbye in one short sentence.')
    diagnostic(`E21 after reconnect: ${String(again.data.output).trim().slice(-40)}`)
    assert.match(String(again.data.output).trim(), /ZEBRA\W*$/, String(again.data.output))
  })

  test('E22 delete an open session leaves no transcript behind', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'claude')).data.session)
    await promptIn(server(), session, 'Reply with exactly OK.')
    const nativeId = session.replace(/^claude_/, '')
    const find = async () => (await readdir(env().claudeConfig, { recursive: true }).catch(() => [])).filter(f => String(f).includes(nativeId))
    assert.equal((await find()).length, 1)
    const deleted = await server().call('delete', { session })
    assert.equal(deleted.isError, false, JSON.stringify(deleted.data))
    assert.equal(deleted.data.native, 'deleted')
    // claude rewrote metadata into the transcript while shutting down; give it time to show up
    await new Promise(resolve => setTimeout(resolve, 3000))
    const left = await find()
    diagnostic(`E22 files with the native id 3s after delete: ${JSON.stringify(left)}`)
    assert.deepEqual(left, [])
    assert.equal(await exists(join(env().home, 'sessions', session)), false)
  })

  test('E52 a question is answered and the reply uses the answer; decline is recorded', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'claude')).data.session)
    const asked = await promptIn(server(), session, COLOR_PROMPT)
    assert.equal(asked.data.status, 'question_needed', JSON.stringify(asked.data))
    const { question_id, content, word } = firstChoice(asked)
    const done = await server().call('answer', { session, question_id, content })
    assert.equal(done.data.status, 'done', JSON.stringify(done.data))
    assert.match(String(done.data.output), new RegExp(word, 'i'))
    const again = await promptIn(server(), session, COLOR_PROMPT)
    diagnostic(`E52 second ask: ${again.data.status}`)
    // Decline first, then cancel whatever the agent asks next, recording each step until the turn ends
    const answerUntilDone = async (reply: ToolReply, actions: string[]): Promise<ToolReply> => {
      const [action, ...rest] = actions
      if (reply.data.status !== 'question_needed' || !action) return reply
      const next = await server().call('answer', { session, question_id: firstChoice(reply).question_id, action })
      diagnostic(`E52 after ${action}: ${next.data.status}/${next.data.outcome}: ${String(next.data.output ?? '').slice(0, 200)}`)
      return answerUntilDone(next, rest)
    }
    const ended = await answerUntilDone(again, ['decline', 'cancel', 'cancel'])
    assert.equal(ended.data.status, 'done', JSON.stringify(ended.data))
  })

  test('E57 title, usage and commands through progress; a mode change is an event', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const session = String((await openSession(server(), env().work, 'claude')).data.session)
    await promptIn(server(), session, 'Reply with exactly OK.')
    const progress = async () => (await server().call('progress', { session })).data
    await until(async () => Boolean((await progress()).title), 60_000, 'title')
    const fed = await progress()
    diagnostic(`E57 title: ${fed.title}; usage: ${JSON.stringify(fed.usage)}; commands: ${(fed.commands as unknown[]).length}`)
    const listed = (await server().call('sessions', { cwd: env().work })).data.sessions as Array<{ session: string; title: string }>
    assert.equal(listed.find(s => s.session === session)?.title, fed.title)
    assert.ok(((fed.usage as { size: number } | null)?.size ?? 0) > 0, JSON.stringify(fed.usage))
    assert.ok((fed.commands as unknown[]).length > 0)
    await server().call('set_config', { session, config_id: 'mode', value: 'plan' })
    // The mode change shows in the conversation as a config event and in the session's config
    await until(async () => (await snapshotItems(server(), session)).some(item => item.kind === 'event' && item.data.configId === 'mode'), 30_000, 'mode event')
    const status = (await server().call('status', { session })).data
    assert.equal(JSON.parse(JSON.stringify(status.config)).mode, 'plan')
    // E70: the session tab lists the commands and fills the context bar
    await showLatest(page(), 'claude')
    await page().getByRole('tab', { name: 'Session' }).click()
    const info = page().getByRole('tabpanel', { name: 'Session' })
    await expect(info.getByText(/^\/\S+$/).first()).toBeVisible()
    await expect(info.getByRole('progressbar')).toBeVisible()
    diagnostic(`E57 mode events: ${JSON.stringify((await snapshotItems(server(), session)).filter(item => item.kind === 'event' && item.data.configId === 'mode'))}`)
  })
})

test.describe('claude e2e: processes, clients and profiles', () => {
  test('E23 SIGKILL of the MCP server leaves no claude-agent-acp or claude behind (recorded)', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const env = await makeEnv()
    const server = await startServer(env.home)
    try {
      const session = String((await openSession(server, env.work, 'claude')).data.session)
      await promptIn(server, session, 'Reply with exactly OK.')
      const serverPid = server.pid ?? assert.fail('no server pid')
      const acp = childPids(serverPid)
      const claude = acp.flatMap(childPids)
      assert.ok(acp.length > 0 && claude.length > 0, `acp ${acp} claude ${claude}`)
      process.kill(serverPid, 'SIGKILL')
      const gone = await until(() => [...acp, ...claude].every(p => !isAlive(p)), 10_000, 'agent processes exit').then(() => true, () => false)
      diagnostic(`E23 agent processes gone within 10s: ${gone}`)
      assert.ok(gone)
    } finally {
      await server.close().catch(() => undefined)
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E24 Codex CLI as the MCP client delegates to claude', async () => {
    test.setTimeout(TURN_TIMEOUT)
    test.skip(!CODEX_PROVIDER_CONFIG, 'needs COCKPIT_E2E_CODEX_CONFIG')
    const env = await makeEnv()
    const clientHome = join(env.root, 'client-codex-home')
    await mkdir(clientHome)
    const passThrough = ['OPENAI_API_KEY', ...(GATEWAY ? ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] : [])]
    await writeFile(join(clientHome, 'config.toml'), clientToml(await readFile(CODEX_PROVIDER_CONFIG ?? '', 'utf-8'), env.home, 300, passThrough))
    try {
      const prompt = `Use the cockpit MCP server. Call its open tool with subagent "claude" and cwd "${env.work}". Then call its prompt tool with the returned session and text "Reply with exactly PONG. Do not run any tools.". Finally print the output field you received.`
      const { code, text } = await codexExec(clientHome, env.work, prompt)
      assert.equal(code, 0, text.slice(-2000))
      assert.match(text.slice(text.lastIndexOf('cockpit/prompt')), /PONG/)
      const sessions = await readdir(join(env.home, 'sessions'))
      assert.deepEqual(sessions.map(s => s.split('_')[0]), ['claude'])
    } finally {
      await rm(env.root, { recursive: true, force: true })
    }
  })

  test('E25 two subagents share one profile with different models', async () => {
    test.setTimeout(TURN_TIMEOUT)
    const probeEnv = await makeEnv()
    const probe = await startServer(probeEnv.home)
    const models = await (async () => {
      try {
        const opened = await openSession(probe, probeEnv.work, 'claude')
        return (opened.data.config_options as ConfigOption[]).find(o => o.id === 'model')?.options.map(o => o.value) ?? []
      } finally {
        await probe.close()
        await rm(probeEnv.root, { recursive: true, force: true })
      }
    })()
    assert.ok(models.length >= 2, `models ${models}`)
    const env = await makeEnv({ one: { model: models[0] }, two: { model: models[1] } })
    const server = await startServer(env.home)
    try {
      const results = await Promise.all(['one', 'two'].map(async name => {
        const session = String((await openSession(server, env.work, name)).data.session)
        const r = await promptIn(server, session, 'Reply with exactly OK.')
        assert.equal(r.data.status, 'done', JSON.stringify(r.data))
        return ((await server.call('status', { session })).data.config as Record<string, string>).model
      }))
      assert.deepEqual(results, [models[0], models[1]])
    } finally {
      await server.close()
      await rm(env.root, { recursive: true, force: true })
    }
  })
})
