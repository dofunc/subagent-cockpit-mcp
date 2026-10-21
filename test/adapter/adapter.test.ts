import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import { loadConfig } from '../../src/config'
import { SessionManager } from '../../src/session/session-manager'
import type { SessionActivity } from '../../src/session/session-manager'
import type { ConfigOptionInfo, OpenParams, ToolCallView } from '../../src/types'
import { FAKE_VERSIONS, fakeProgram, isAlive, ofKind, recordActivity, setup, sleep, spawnServer, until } from '../fixtures/harness'
import type { Harness, HarnessOptions } from '../fixtures/harness'
import type { Step } from '../fixtures/scripted-acp-agent'

async function withHarness(opts: HarnessOptions, fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setup(opts)
  try {
    await fn(h)
  } finally {
    await h.cleanup()
  }
}

const open = (h: Harness, extra: Partial<OpenParams> = {}) => h.manager.open({ subagent: 'agent', cwd: h.dir, ...extra })
const userPrompts = async (h: Harness) => (await h.events('prompt')).filter(e => !String(e.text).startsWith('[subagent-cockpit]'))
const childEnv = async (h: Harness) => (await h.events('start')).map(e => e.env)

describe('prompt and output', () => {
  test('U5 role is sent as the first prompt', () => withHarness({}, async h => {
    await open(h, { role: 'Reviewer' })
    const prompts = await h.events('prompt')
    assert.match(String(prompts[0].text), /Reviewer/)
  }))

  test('U7 done returns the joined reply', () => withHarness({ scripts: { agent: { turns: [[{ chunk: 'a' }, { chunk: 'b' }, { chunk: 'c' }]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    assert.equal(r.status, 'done')
    assert.equal(r.output, 'abc')
    assert.deepEqual(h.manager.output(session), { turn_id: r.turn_id, output: 'abc' })
  }))

  test('U8 prompt while RUNNING is SESSION_BUSY', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 2000 }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'first', false)
    await assert.rejects(h.manager.prompt(session, 'second', true), { code: 'SESSION_BUSY' })
  }))

  test('U19 a blocking prompt waits without a limit', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 3000 }, { chunk: 'late' }]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    assert.equal(r.status, 'done')
    assert.equal(r.output, 'late')
  }))

  test('U112 messages are separated by a blank line', () => withHarness({
    scripts: {
      agent: {
        turns: [
          [{ chunk: 'a', messageId: 'm1' }, { chunk: 'b', messageId: 'm1' }, { chunk: 'c', messageId: 'm2' }],
          [{ chunk: 'Running.' }, { tool: { id: 't1', title: 'sleep' } }, { chunk: 'DONE' }],
        ],
      },
    },
  }, async h => {
    const { session } = await open(h)
    assert.equal((await h.manager.prompt(session, 'one', true)).output, 'ab\n\nc')
    assert.equal((await h.manager.prompt(session, 'two', true)).output, 'Running.\n\nDONE')
  }))

  test('U21 wait:false returns running right away', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 2000 }]] } } }, async h => {
    const { session } = await open(h)
    const started = Date.now()
    const r = await h.manager.prompt(session, 'go', false)
    assert.equal(r.status, 'running')
    assert.ok(Date.now() - started < 1000)
    await until(async () => (await userPrompts(h)).length === 1, 5000, 'prompt delivered')
  }))

  test('U44 empty prompt is INVALID_STATE and nothing is sent', () => withHarness({}, async h => {
    const { session } = await open(h)
    await assert.rejects(h.manager.prompt(session, '', true), { code: 'INVALID_STATE' })
    assert.equal((await userPrompts(h)).length, 0)
  }))

  test('U73 agent error on session/prompt is AGENT_ERROR and the session returns to IDLE', () => withHarness({ scripts: { agent: { turns: [[{ error: 'boom' }]] } } }, async h => {
    const { session } = await open(h)
    await assert.rejects(h.manager.prompt(session, 'go', true), { code: 'AGENT_ERROR' })
    assert.equal(h.manager.status(session).state, 'IDLE')
  }))
})

describe('approvals', () => {
  // The sleep keeps the turn running after an answer, so a cancel always reaches it
  const asking = { scripts: { agent: { turns: [[{ permission: {} }, { sleep: 300 }, { chunk: 'after' }]] } } }

  test('U9 approval_needed carries all options', () => withHarness(asking, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    assert.equal(r.status, 'approval_needed')
    assert.deepEqual(r.approval?.options.map(o => o.kind), ['allow_once', 'allow_always', 'reject_once', 'reject_always'])
    assert.equal(h.manager.status(session).state, 'ASKING')
  }))

  test('U10 prompt in ASKING returns the same approval without sending', () => withHarness(asking, async h => {
    const { session } = await open(h)
    const first = await h.manager.prompt(session, 'go', true)
    const second = await h.manager.prompt(session, 'again', true)
    assert.equal(second.status, 'approval_needed')
    assert.equal(second.approval?.approval_id, first.approval?.approval_id)
    assert.equal((await userPrompts(h)).length, 1)
  }))

  // allow answers allow_once and keeps the rule in the adapter (see "allow rules")
  for (const [id, verb, option] of [['U11', 'approve', 'opt-allow_once'], ['U12', 'allow', 'opt-allow_once'], ['U13', 'reject', 'opt-reject_once']] as const) {
    test(`${id} ${verb} answers ${option}`, () => withHarness(asking, async h => {
      const { session } = await open(h)
      const r = await h.manager.prompt(session, 'go', true)
      const done = await h.manager.respond(verb, session, r.approval?.approval_id ?? '', undefined, true)
      assert.equal(done.status, 'done')
      const [permission] = await h.events('permission')
      assert.deepEqual(permission.outcome, { outcome: 'selected', optionId: option })
    }))
  }

  test('U14 unknown option_id is INVALID_OPTION and stays ASKING', () => withHarness(asking, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    await assert.rejects(h.manager.respond('approve', session, r.approval?.approval_id ?? '', 'nope', true), { code: 'INVALID_OPTION' })
    assert.equal(h.manager.status(session).state, 'ASKING')
  }))

  test('U15 allow never picks a persistent allow_always option', () => withHarness({ scripts: { agent: { turns: [[{ permission: { kinds: ['allow_always', 'reject_once'] } }]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    await assert.rejects(h.manager.respond('allow', session, r.approval?.approval_id ?? '', undefined, true), { code: 'INVALID_OPTION' })
    assert.equal(h.manager.status(session).state, 'ASKING')
  }))

  test('U16 approving a handled id in IDLE returns done without answering', () => withHarness(asking, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const id = r.approval?.approval_id ?? ''
    await h.manager.respond('approve', session, id, undefined, true)
    const again = await h.manager.respond('approve', session, id, undefined, true)
    assert.equal(again.status, 'done')
    assert.equal((await h.events('permission')).length, 1)
  }))

  test('U17 cancel in ASKING answers cancelled, then sends session/cancel', () => withHarness(asking, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    assert.deepEqual(h.manager.cancel(session), { status: 'cancelling' })
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    const wire = await h.events('wire')
    const answered = wire.findIndex(e => e.outcome === 'cancelled')
    const cancel = wire.findIndex(e => e.method === 'session/cancel')
    assert.ok(answered >= 0 && answered < cancel, JSON.stringify(wire))
  }))

  test('U40 concurrent approve and reject answer once', () => withHarness(asking, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const id = r.approval?.approval_id ?? ''
    const results = await Promise.all([
      h.manager.respond('approve', session, id, undefined, true),
      h.manager.respond('reject', session, id, undefined, true),
    ])
    assert.ok(results.every(x => x.status === 'done' || x.status === 'running'))
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    assert.equal((await h.events('permission')).length, 1)
  }))

  test('U59 a late approve with a handled id does not answer the next request', () => withHarness({ scripts: { agent: { turns: [[{ permission: { title: 'A' } }, { permission: { title: 'B' } }]] } } }, async h => {
    const { session } = await open(h)
    const a = await h.manager.prompt(session, 'go', true)
    const b = await h.manager.respond('approve', session, a.approval?.approval_id ?? '', undefined, true)
    assert.equal(b.approval?.title, 'B')
    const late = await h.manager.respond('approve', session, a.approval?.approval_id ?? '', undefined, true)
    assert.equal(late.status, 'approval_needed')
    assert.equal(late.approval?.approval_id, b.approval?.approval_id)
    assert.equal((await h.events('permission')).length, 1)
  }))

  test('U60 two pending approvals are answered separately', () => withHarness({ scripts: { agent: { turns: [[{ permissions: ['A', 'B'] }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    await until(() => h.manager.status(session).approvals.length === 2, 5000, 'two approvals')
    const [first, second] = h.manager.status(session).approvals
    await h.manager.respond('approve', session, first.approval_id, undefined, false)
    await h.manager.respond('reject', session, second.approval_id, undefined, true)
    const outcomes = (await h.events('permission')).map(e => [e.title, e.outcome])
    assert.deepEqual(outcomes.sort(), [['A', { outcome: 'selected', optionId: 'opt-allow_once' }], ['B', { outcome: 'selected', optionId: 'opt-reject_once' }]])
  }))

  test('U61 approval_id never issued is INVALID_OPTION', () => withHarness(asking, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    await assert.rejects(h.manager.respond('approve', session, 'nope', undefined, true), { code: 'INVALID_OPTION' })
    assert.equal(h.manager.status(session).state, 'ASKING')
  }))
})

describe('allow rules', () => {
  const touch = (command: string, extra: { prefix?: string; sessionAllow?: boolean } = { prefix: 'touch' }) => ({ exec: { command, ...extra } })
  const outcomes = async (h: Harness) => (await h.events('permission')).map(e => [e.title, e.outcome])
  const selected = (optionId: string) => ({ outcome: 'selected', optionId })

  test('U102 after allow, a command with the same proposed prefix is answered without asking', () => withHarness({ scripts: { agent: { turns: [[touch('touch a.txt'), touch('touch b.txt'), { chunk: 'end' }]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const done = await h.manager.respond('allow', session, r.approval?.approval_id ?? '', undefined, true)
    assert.equal(done.status, 'done')
    assert.deepEqual(await outcomes(h), [['touch a.txt', selected('allow_once')], ['touch b.txt', selected('allow_once')]])
    assert.ok(h.manager.snapshot({}).sessions[0].events.some(e => e.type === 'auto_approved' && e.text === 'Run command'))
  }))

  test('U103 a command outside the allowed prefix still asks', () => withHarness({ scripts: { agent: { turns: [[touch('touch a.txt'), touch('mkdir out', { prefix: 'mkdir' })]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const next = await h.manager.respond('allow', session, r.approval?.approval_id ?? '', undefined, true)
    assert.equal(next.status, 'approval_needed')
  }))

  test('U104 allow rules end with the session', () => withHarness({ scripts: { agent: { turns: [[touch('touch a.txt')], [touch('touch b.txt')]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    await h.manager.respond('allow', session, r.approval?.approval_id ?? '', undefined, true)
    await h.manager.close(session)
    await open(h, { session })
    // The reconnected agent process starts its script over: turn 0 asks for touch a.txt again
    const again = await h.manager.prompt(session, 'go', true)
    assert.equal(again.status, 'approval_needed')
  }))

  test('U105 an auto-answered request leaves no approval notification', () => withHarness({ scripts: { agent: { turns: [[touch('touch a.txt')], [touch('touch b.txt')]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    await h.manager.respond('allow', session, r.approval?.approval_id ?? '', undefined, true)
    await h.manager.prompt(session, 'again', false)
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    assert.ok(h.manager.snapshot({}).sessions[0].notifications.every(n => n.type !== 'approval'))
  }))

  test('U106 a native session-scoped option is used as is, without an adapter rule', () => withHarness({ scripts: { agent: { turns: [[touch('touch a.txt', { sessionAllow: true, prefix: 'touch' }), touch('touch a.txt', { sessionAllow: true, prefix: 'touch' })]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const next = await h.manager.respond('allow', session, r.approval?.approval_id ?? '', undefined, true)
    assert.equal(next.status, 'approval_needed')
    assert.deepEqual((await outcomes(h))[0], ['touch a.txt', selected('allow_for_session')])
  }))

  test('U107 without a proposed prefix the rule is the exact command', () => withHarness({ scripts: { agent: { turns: [[touch('touch a.txt', {}), touch('touch a.txt', {}), touch('touch b.txt', {})]] } } }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const next = await h.manager.respond('allow', session, r.approval?.approval_id ?? '', undefined, true)
    assert.equal(next.status, 'approval_needed')
    assert.equal(next.approval?.title, 'Run command')
    assert.deepEqual((await outcomes(h)).map(([title]) => title), ['touch a.txt', 'touch a.txt'])
  }))

  test('U108 allow also answers pending requests the new rule covers', () => withHarness({ scripts: { agent: { turns: [[{ execs: [{ command: 'touch a.txt', prefix: 'touch' }, { command: 'touch b.txt', prefix: 'touch' }] }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).approvals.length === 2, 5000, 'two approvals')
    const [first] = h.manager.status(session).approvals
    const done = await h.manager.respond('allow', session, first.approval_id, undefined, true)
    assert.equal(done.status, 'done')
    assert.deepEqual((await outcomes(h)).map(([, o]) => o), [selected('allow_once'), selected('allow_once')])
  }))
})

describe('cancel', () => {
  test('U18 cancel while RUNNING', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 5000 }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    assert.deepEqual(h.manager.cancel(session), { status: 'cancelling' })
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    assert.equal((await h.events('cancel')).length, 1)
  }))

  test('U62 prompt before the cancel is confirmed is SESSION_BUSY', () => withHarness({ scripts: { agent: { delays: { cancel: 2000 }, turns: [[{ sleep: 5000 }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    h.manager.cancel(session)
    await sleep(300)
    await assert.rejects(h.manager.prompt(session, 'next', true), { code: 'SESSION_BUSY' })
    const status = h.manager.status(session)
    assert.equal(status.state, 'RUNNING')
    assert.equal(status.cancelling, true)
  }))

  test('U63 tail chunks after cancel belong to the cancelled turn', () => withHarness({ scripts: { agent: { cancelTail: ['t1', 't2'], turns: [[{ sleep: 5000 }]] } } }, async h => {
    const { session } = await open(h)
    const first = await h.manager.prompt(session, 'go', false)
    h.manager.cancel(session)
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    const next = await h.manager.prompt(session, 'next', true)
    assert.equal(next.output, 'done')
    const events = h.manager.snapshot({}).sessions[0].events
    const tails = events.filter(e => e.text === 't1' || e.text === 't2')
    assert.equal(tails.length, 2)
    assert.ok(tails.every(e => e.turn_id === first.turn_id))
  }))
})

describe('agent exit and auth', () => {
  test('U23 exit while RUNNING fails the blocking call with SUBAGENT_EXITED', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 300 }, { exit: 1 }]] } } }, async h => {
    const { session } = await open(h)
    await assert.rejects(h.manager.prompt(session, 'go', true), { code: 'SUBAGENT_EXITED' })
    const [row] = await h.manager.list()
    assert.equal(row.state, 'CLOSED')
    assert.throws(() => h.manager.status(session), { code: 'SESSION_NOT_FOUND' })
  }))

  test('U24 exit while ASKING clears pending approvals', () => withHarness({ scripts: { agent: { turns: [[{ permission: {} }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    const [start] = await h.events('start')
    process.kill(Number(start.pid), 'SIGKILL')
    await until(async () => (await h.manager.list())[0].state === 'CLOSED', 5000, 'CLOSED')
    assert.equal(h.manager.snapshot({}).sessions.length, 0)
  }))

  test('U25 auth_required maps to AUTH_REQUIRED without calling authenticate', () => withHarness({ scripts: { agent: { authRequired: true } } }, async h => {
    await assert.rejects(open(h), (err: Error & { code?: string }) => err.code === 'AUTH_REQUIRED' && /codex login/.test(err.message))
    assert.equal((await h.events('authenticate')).length, 0)
  }))
})

describe('reconnect variants', () => {
  test('U27 falls back to session/resume', () => withHarness({ scripts: { agent: { loadSession: false, resume: true } } }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await open(h, { session })
    assert.equal((await h.events('resume')).length, 1)
    assert.equal((await h.events('load')).length, 0)
  }))

  test('U28 neither load nor resume is RESUME_NOT_SUPPORTED', () => withHarness({ scripts: { agent: { loadSession: false } } }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await assert.rejects(open(h, { session }), { code: 'RESUME_NOT_SUPPORTED' })
  }))
})

describe('config options', () => {
  test('U29 set_config changes the model', () => withHarness({}, async h => {
    const { session } = await open(h)
    const options = await h.manager.setConfig(session, 'model', 'x')
    assert.equal(options.find(o => o.id === 'model')?.current_value, 'x')
    assert.deepEqual((await h.events('set_config')).map(e => [e.configId, e.value]), [['model', 'x']])
  }))

  test('U30 unknown config_id or value is INVALID_OPTION listing the choices', () => withHarness({}, async h => {
    const { session } = await open(h)
    await assert.rejects(h.manager.setConfig(session, 'nope', 'x'), { code: 'INVALID_OPTION', message: /available: mode, model, reasoning_effort/ })
    await assert.rejects(h.manager.setConfig(session, 'model', 'nope'), { code: 'INVALID_OPTION', message: /available: gpt-a, gpt-b, x/ })
    assert.equal((await h.events('set_config')).length, 0)
  }))

  test('U111 status carries current values; open and snapshot carry the choices', () => withHarness({}, async h => {
    const opened = await open(h)
    assert.deepEqual(opened.config_options.map(o => o.options.length), [3, 3, 3])
    const status = h.manager.status(opened.session)
    assert.deepEqual(status.config, { mode: 'auto', model: 'gpt-a', reasoning_effort: 'medium' })
    assert.equal('config_options' in status, false)
    assert.deepEqual(h.manager.snapshot({}).sessions[0].config_options, opened.config_options)
  }))

  test('U70 initial config is applied before the role prompt', () => withHarness({ subagent: { model: 'gpt-b', reasoning_effort: 'high' } }, async h => {
    await open(h)
    const log = (await h.log()).filter(e => e.event === 'set_config' || e.event === 'prompt')
    assert.deepEqual(log.map(e => e.event), ['set_config', 'set_config', 'prompt'])
    assert.deepEqual(log.slice(0, 2).map(e => [e.configId, e.value]), [['model', 'gpt-b'], ['reasoning_effort', 'high']])
  }))

  test('U71 set_config changes the mode', () => withHarness({}, async h => {
    const { session } = await open(h)
    await h.manager.setConfig(session, 'mode', 'read-only')
    assert.equal(h.manager.status(session).config.mode, 'read-only')
    assert.deepEqual((await h.events('set_config')).map(e => e.value), ['read-only'])
  }))
})

describe('event buffer', () => {
  test('U31 keeps the latest 500 events', () => withHarness({ scripts: { agent: { turns: [[{ chunks: 600 }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    const { events } = h.manager.snapshot({}).sessions[0]
    assert.equal(events.length, 500)
    assert.equal(events.at(-1)?.text, 'c599;')
  }))
})

describe('open timing', () => {
  test('U68 slow initialize: open returns once setup and the role prompt are done', () => withHarness({ scripts: { agent: { delays: { initialize: 3000, role: 400 } } } }, async h => {
    const started = Date.now()
    const opened = await open(h)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 3300 && elapsed < 5000, `elapsed ${elapsed}`)
    assert.ok(opened.session)
    assert.equal(opened.status, 'done')
    assert.equal(opened.config_options.length, 3)
    assert.equal(h.manager.status(opened.session).state, 'IDLE')
  }))
})

describe('environment', () => {
  test('U3 empty string deletes a variable', () => withHarness({ scripts: { agent: { envKeys: ['COCKPIT_FOO'] } }, env: { agent: { COCKPIT_FOO: '' } } }, async h => {
    process.env.COCKPIT_FOO = 'system'
    try {
      await open(h)
      assert.deepEqual(await childEnv(h), [{ COCKPIT_FOO: null }])
    } finally {
      delete process.env.COCKPIT_FOO
    }
  }))

  test('U72 DEFAULT_AUTH_REQUEST passes through as configured', () => withHarness({ scripts: { agent: { envKeys: ['DEFAULT_AUTH_REQUEST'] }, other: { envKeys: ['DEFAULT_AUTH_REQUEST'] } }, env: { other: { DEFAULT_AUTH_REQUEST: 'api-key' } } }, async h => {
    process.env.DEFAULT_AUTH_REQUEST = 'system'
    try {
      await open(h)
      await h.manager.open({ subagent: 'other', cwd: h.dir })
      assert.deepEqual(await childEnv(h), [{ DEFAULT_AUTH_REQUEST: 'system' }, { DEFAULT_AUTH_REQUEST: 'api-key' }])
    } finally {
      delete process.env.DEFAULT_AUTH_REQUEST
    }
  }))

  test('U52 configured credentials reach only their own session', () => withHarness({
    scripts: { a: { envKeys: ['OPENAI_API_KEY'] }, b: { envKeys: ['OPENAI_API_KEY'] } },
    env: { a: { OPENAI_API_KEY: 'k1' }, b: { OPENAI_API_KEY: 'k2' } },
  }, async h => {
    await h.manager.open({ subagent: 'a', cwd: h.dir })
    await h.manager.open({ subagent: 'b', cwd: h.dir })
    assert.deepEqual(await childEnv(h), [{ OPENAI_API_KEY: 'k1' }, { OPENAI_API_KEY: 'k2' }])
  }))

  test('U54 env values are not written to disk or logs', () => withHarness({ env: { agent: { OPENAI_API_KEY: 'k1-secret-value' } } }, async h => {
    const logs: string[] = []
    h.host.log = (message: string) => { logs.push(message) }
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    const dir = join(h.home, 'sessions', session)
    const files = await readdir(dir)
    const contents = await Promise.all(files.map(f => readFile(join(dir, f), 'utf-8')))
    assert.ok(contents.every(c => !c.includes('k1-secret-value')))
    assert.ok(logs.every(l => !l.includes('k1-secret-value')))
  }))

  for (const [id, value, expected] of [['U100', '${COCKPIT_BAR}', 'x'], ['U101', '${COCKPIT_UNDEFINED_VAR}', null]] as const) {
    test(`${id} \${VAR} reference resolves to ${expected}`, () => withHarness({}, async h => {
      process.env.COCKPIT_BAR = 'x'
      process.env.COCKPIT_FOO = 'system'
      try {
        const configPath = join(h.home, 'config.json')
        const raw = JSON.parse(await readFile(configPath, 'utf-8'))
        raw.subagents.agent.env.COCKPIT_FOO = value
        await writeFile(configPath, JSON.stringify(raw))
        await writeFile(h.scriptPath('agent'), JSON.stringify({ envKeys: ['COCKPIT_FOO'] }))
        const manager = new SessionManager(h.host, await loadConfig(h.host, h.home), h.home)
        try {
          await manager.open({ subagent: 'agent', cwd: h.dir })
          assert.deepEqual(await childEnv(h), [{ COCKPIT_FOO: expected }])
        } finally {
          await manager.shutdown()
        }
      } finally {
        delete process.env.COCKPIT_BAR
        delete process.env.COCKPIT_FOO
      }
    }))
  }
})

const rejectsWith = (code: string, pattern: RegExp) => (err: Error & { code?: string }) => err.code === code && pattern.test(err.message)

describe('local program', () => {
  test('U45 codex below 0.160.1 is AGENT_VERSION_UNSUPPORTED', () => withHarness({}, async h => {
    h.config.subagents.agent.path = await fakeProgram(join(h.dir, 'old-codex'), 'codex-cli 0.150.0')
    await assert.rejects(open(h), rejectsWith('AGENT_VERSION_UNSUPPORTED', /0\.150\.0.*0\.160\.1/))
    assert.equal((await h.events('start')).length, 0)
  }))

  test('U46 a configured path that does not exist is AGENT_NOT_FOUND', () => withHarness({}, async h => {
    const missing = join(h.dir, 'no-such-codex')
    h.config.subagents.agent.path = missing
    await assert.rejects(open(h), rejectsWith('AGENT_NOT_FOUND', new RegExp(missing)))
    assert.equal((await h.events('start')).length, 0)
  }))

  test('U113 an empty path looks the program up in PATH', () => withHarness({ scripts: { agent: { envKeys: ['CODEX_PATH'] } } }, async h => {
    const bin = join(h.dir, 'bin')
    await mkdir(bin)
    const program = await fakeProgram(join(bin, 'codex'), FAKE_VERSIONS.codex)
    Object.assign(h.config.subagents.agent, { path: '', env: { ...h.config.subagents.agent.env, PATH: bin } })
    await open(h)
    assert.deepEqual(await childEnv(h), [{ CODEX_PATH: program }])
  }))

  test('U114 a program missing from PATH is AGENT_NOT_FOUND', () => withHarness({}, async h => {
    const empty = join(h.dir, 'empty')
    await mkdir(empty)
    Object.assign(h.config.subagents.agent, { path: '', env: { ...h.config.subagents.agent.env, PATH: empty } })
    await assert.rejects(open(h), rejectsWith('AGENT_NOT_FOUND', /codex not found in PATH.*path/))
  }))

  test('U115 the subagent env cannot override the path variable', () => withHarness({ scripts: { agent: { envKeys: ['CODEX_PATH'] } }, env: { agent: { CODEX_PATH: '/elsewhere' } } }, async h => {
    await open(h)
    assert.deepEqual(await childEnv(h), [{ CODEX_PATH: h.config.subagents.agent.path }])
  }))

  test('U116 --version failing, printing no version or hanging is AGENT_NOT_FOUND', () => withHarness({}, async h => {
    const scripts = [['fails', 'exit 1'], ['silent', 'echo hello'], ['hangs', 'sleep 15']]
    const paths = await Promise.all(scripts.map(async ([name, body]) => {
      const path = join(h.dir, name)
      await writeFile(path, `#!/bin/sh\n${body}\n`)
      await chmod(path, 0o755)
      return path
    }))
    await paths.slice(0, 2).reduce(async (prev, path) => {
      await prev
      h.config.subagents.agent.path = path
      await assert.rejects(open(h), rejectsWith('AGENT_NOT_FOUND', /--version/))
    }, Promise.resolve())
    h.config.subagents.agent.path = paths[2]
    const started = Date.now()
    await assert.rejects(open(h), rejectsWith('AGENT_NOT_FOUND', /--version/))
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 9_500 && elapsed < 13_000, `elapsed ${elapsed}`)
  }))

  for (const adapter of ['codex', 'claude'] as const) {
    const pathEnv = adapter === 'codex' ? 'CODEX_PATH' : 'CLAUDE_CODE_EXECUTABLE'
    test(`U134 relative paths become absolute (${adapter})`, () => withHarness({ adapter, scripts: { agent: { envKeys: [pathEnv] } } }, async h => {
      const bin = join(h.dir, 'bin')
      await mkdir(bin)
      const program = await fakeProgram(join(bin, adapter), FAKE_VERSIONS[adapter])
      const work = join(h.dir, 'work')
      await mkdir(work)
      const baseEnv = h.config.subagents.agent.env
      const variants = [
        { path: relative(process.cwd(), program), env: baseEnv },
        { path: adapter, env: { ...baseEnv, PATH: relative(process.cwd(), bin) } },
        { path: '', env: { ...baseEnv, PATH: relative(process.cwd(), bin) } },
      ]
      await variants.reduce(async (prev, variant) => {
        await prev
        Object.assign(h.config.subagents.agent, variant)
        const { session } = await open(h, { cwd: work })
        await h.manager.close(session)
      }, Promise.resolve())
      assert.deepEqual(await childEnv(h), variants.map(() => ({ [pathEnv]: program })))
    }))
  }

  test('U126 codex ignores args and says so on stderr', () => withHarness({ subagent: { args: ['--foo'] } }, async h => {
    const logs: string[] = []
    h.host.log = (message: string) => { logs.push(message) }
    await open(h)
    assert.deepEqual((await h.events('new')).map(e => e.meta), [null])
    assert.ok(logs.some(l => l.includes('codex adapter ignores args')))
  }))
})

const select = (id: string, category: string, values: string[]): acp.SessionConfigOption => ({
  type: 'select', id, name: id, category, currentValue: values[0], options: values.map(v => ({ value: v, name: v })),
})
const setConfigs = async (h: Harness) => (await h.events('set_config')).map(e => [e.configId, e.value])

describe('claude adapter', () => {
  const claudeOptions = [
    select('mode', 'mode', ['default', 'acceptEdits', 'plan']),
    select('model', 'model', ['default', 'm']),
    select('effort', 'thought_level', ['medium', 'high']),
  ]

  test('U119 the local claude goes in CLAUDE_CODE_EXECUTABLE, never codex variables', () => withHarness({
    adapter: 'claude',
    subagent: { mode: 'plan' },
    scripts: { agent: { configOptions: claudeOptions, envKeys: ['CLAUDE_CODE_EXECUTABLE', 'CODEX_PATH', 'INITIAL_AGENT_MODE'] } },
  }, async h => {
    await open(h)
    assert.deepEqual(await childEnv(h), [{ CLAUDE_CODE_EXECUTABLE: h.config.subagents.agent.path, CODEX_PATH: null, INITIAL_AGENT_MODE: null }])
  }))

  test('U120 claude below the minimum is AGENT_VERSION_UNSUPPORTED', () => withHarness({ adapter: 'claude' }, async h => {
    h.config.subagents.agent.path = await fakeProgram(join(h.dir, 'old-claude'), '2.1.100 (Claude Code)')
    await assert.rejects(open(h), rejectsWith('AGENT_VERSION_UNSUPPORTED', /claude 2\.1\.100.*2\.1\.292/))
  }))

  test('U121 initial config: model, effort, then mode, before the role prompt', () => withHarness({
    adapter: 'claude',
    subagent: { model: 'm', reasoning_effort: 'high', mode: 'plan' },
    scripts: { agent: { configOptions: claudeOptions } },
  }, async h => {
    await open(h)
    assert.deepEqual(await setConfigs(h), [['model', 'm'], ['effort', 'high'], ['mode', 'plan']])
    const order = (await h.log()).filter(e => e.event === 'set_config' || e.event === 'prompt').map(e => e.event)
    assert.deepEqual(order, ['set_config', 'set_config', 'set_config', 'prompt'])
  }))

  test('U122 initial config skips empty values and options the agent lacks', () => withHarness({
    adapter: 'claude',
    subagent: { mode: 'plan', reasoning_effort: 'high' },
    scripts: { agent: { configOptions: [claudeOptions[0], claudeOptions[1]] } },
  }, async h => {
    await open(h)
    assert.deepEqual(await setConfigs(h), [['mode', 'plan']])
  }))

  const extraArgsMeta = { claudeCode: { options: { extraArgs: { 'add-dir': '/a', verbose: null, model: 'x' } } } }

  test('U123 args become extraArgs in session/new', () => withHarness({ adapter: 'claude', subagent: { args: ['--add-dir', '/a', '--verbose', '--model=x'] } }, async h => {
    await open(h)
    assert.deepEqual((await h.events('new')).map(e => e.meta), [extraArgsMeta])
  }))

  test('U124 args travel with session/load on reconnect', () => withHarness({ adapter: 'claude', subagent: { args: ['--add-dir', '/a', '--verbose', '--model=x'] } }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await open(h, { session })
    assert.deepEqual((await h.events('load')).map(e => e.meta), [extraArgsMeta])
  }))

  test('U125 short flags and stray values are ignored with a note', () => withHarness({ adapter: 'claude', subagent: { args: ['-v', 'stray', '--debug'] } }, async h => {
    const logs: string[] = []
    h.host.log = (message: string) => { logs.push(message) }
    await open(h)
    assert.deepEqual((await h.events('new')).map(e => e.meta), [{ claudeCode: { options: { extraArgs: { debug: null } } } }])
    assert.equal(logs.filter(l => l.includes('claude adapter ignores arg')).length, 2)
  }))

  test('U127 allow matches the exact command, whatever the description', () => withHarness({
    adapter: 'claude',
    scripts: { agent: { turns: [[
      { bash: { command: 'npm test', description: 'a' } },
      { bash: { command: 'npm test', description: 'b' } },
      { bash: { command: 'npm test -- x', description: 'c' } },
    ]] } },
  }, async h => {
    const { session } = await open(h)
    const first = await h.manager.prompt(session, 'go', true)
    const next = await h.manager.respond('allow', session, first.approval?.approval_id ?? '', undefined, true)
    assert.equal(next.status, 'approval_needed')
    assert.equal(next.approval?.title, 'npm test -- x')
    const answered = (await h.events('permission')).map(e => [e.title, e.outcome])
    assert.deepEqual(answered, [
      ['npm test#a', { outcome: 'selected', optionId: 'allow-once' }],
      ['npm test#b', { outcome: 'selected', optionId: 'allow-once' }],
    ])
  }))

  test('U128 auth_required points at claude, without calling authenticate', () => withHarness({ adapter: 'claude', scripts: { agent: { authRequired: true } } }, async h => {
    await assert.rejects(open(h), rejectsWith('AUTH_REQUIRED', /claude/))
    assert.equal((await h.events('authenticate')).length, 0)
  }))
})

describe('grok adapter', () => {
  const grokOptions = [
    select('model', 'model', ['default', 'm']),
    select('reasoning_effort', 'thought_level', ['medium', 'low', 'high', 'xhigh']),
  ]
  const grokBash = (command: string, description: string) => ({ bash: { command, description, style: 'grok' as const } })

  test('U138/U139 grok runs as `agent --no-leader <args> stdio`, args never go to _meta', () => withHarness({
    adapter: 'grok',
    subagent: { args: ['--always-approve', '-m', 'x'] },
    scripts: { agent: { envKeys: ['CODEX_PATH', 'CLAUDE_CODE_EXECUTABLE', 'INITIAL_AGENT_MODE'] } },
  }, async h => {
    const logs: string[] = []
    h.host.log = (message: string) => { logs.push(message) }
    const { session } = await open(h)
    assert.deepEqual((await h.events('argv')).map(e => e.argv), [['agent', '--no-leader', '--always-approve', '-m', 'x', 'stdio']])
    assert.deepEqual(await childEnv(h), [{ CODEX_PATH: null, CLAUDE_CODE_EXECUTABLE: null, INITIAL_AGENT_MODE: null }])
    assert.match(session, /^grok_/)
    assert.deepEqual((await h.events('new')).map(e => e.meta), [null])
    assert.ok(logs.every(l => !l.includes('ignores args')))
  }))

  test('U140 grok below the minimum is AGENT_VERSION_UNSUPPORTED', () => withHarness({ adapter: 'grok' }, async h => {
    h.config.subagents.agent.path = await fakeProgram(join(h.dir, 'old-grok'), 'grok 1.0.10 (x)')
    await assert.rejects(open(h), rejectsWith('AGENT_VERSION_UNSUPPORTED', /grok 1\.0\.10.*1\.0\.46/))
    assert.equal((await h.events('start')).length, 0)
  }))

  test('U141 initial config: model, then reasoning_effort, before the role prompt', () => withHarness({
    adapter: 'grok',
    subagent: { model: 'm', reasoning_effort: 'low' },
    scripts: { agent: { configOptions: grokOptions } },
  }, async h => {
    await open(h)
    assert.deepEqual(await setConfigs(h), [['model', 'm'], ['reasoning_effort', 'low']])
    const order = (await h.log()).filter(e => e.event === 'set_config' || e.event === 'prompt').map(e => e.event)
    assert.deepEqual(order, ['set_config', 'set_config', 'prompt'])
  }))

  test('U142 grok ignores mode and says so on stderr', () => withHarness({
    adapter: 'grok',
    subagent: { mode: 'plan' },
    scripts: { agent: { configOptions: grokOptions } },
  }, async h => {
    const logs: string[] = []
    h.host.log = (message: string) => { logs.push(message) }
    await open(h)
    assert.deepEqual(await setConfigs(h), [])
    assert.deepEqual((await h.events('new')).map(e => e.meta), [null])
    assert.ok(logs.some(l => l.includes('grok adapter ignores mode')))
  }))

  test('U143 allow matches the exact command, whatever the description', () => withHarness({
    adapter: 'grok',
    scripts: { agent: { turns: [[grokBash('npm test', 'a'), grokBash('npm test', 'b'), grokBash('npm test -- x', 'c')]] } },
  }, async h => {
    const { session } = await open(h)
    const first = await h.manager.prompt(session, 'go', true)
    const next = await h.manager.respond('allow', session, first.approval?.approval_id ?? '', undefined, true)
    assert.equal(next.status, 'approval_needed')
    assert.equal(next.approval?.title, 'npm test -- x')
    const answered = (await h.events('permission')).map(e => [e.title, e.outcome])
    assert.deepEqual(answered, [
      ['npm test#a', { outcome: 'selected', optionId: 'allow-once' }],
      ['npm test#b', { outcome: 'selected', optionId: 'allow-once' }],
    ])
  }))

  test('U144 approve and reject pick allow-once and reject-once', () => withHarness({
    adapter: 'grok',
    scripts: { agent: { turns: [[grokBash('ls', 'a'), grokBash('rm x', 'b'), { chunk: 'end' }]] } },
  }, async h => {
    const { session } = await open(h)
    const first = await h.manager.prompt(session, 'go', true)
    const second = await h.manager.respond('approve', session, first.approval?.approval_id ?? '', undefined, true)
    const done = await h.manager.respond('reject', session, second.approval?.approval_id ?? '', undefined, true)
    assert.equal(done.status, 'done')
    const answered = (await h.events('permission')).map(e => e.outcome)
    assert.deepEqual(answered, [{ outcome: 'selected', optionId: 'allow-once' }, { outcome: 'selected', optionId: 'reject-once' }])
  }))

  test('U146 auth_required points at grok login and XAI_API_KEY, without calling authenticate', () => withHarness({ adapter: 'grok', scripts: { agent: { authRequired: true } } }, async h => {
    await assert.rejects(open(h), rejectsWith('AUTH_REQUIRED', /grok login.*XAI_API_KEY/))
    assert.equal((await h.events('authenticate')).length, 0)
  }))
})

describe('opencode adapter', () => {
  const opencodeOptions = [
    select('model', 'model', ['openai/default', 'openai/m']),
    select('effort', 'thought_level', ['default', 'low', 'high']),
    select('mode', 'mode', ['build', 'plan']),
  ]
  const opencodeBash = (command: string, description: string) => ({ bash: { command, description, style: 'opencode' as const } })

  test('U150/U151 opencode runs as `acp <args>`, args never go to _meta', () => withHarness({
    adapter: 'opencode',
    subagent: { args: ['--log-level', 'warn'] },
    scripts: { agent: { envKeys: ['CODEX_PATH', 'CLAUDE_CODE_EXECUTABLE', 'INITIAL_AGENT_MODE'] } },
  }, async h => {
    const logs: string[] = []
    h.host.log = (message: string) => { logs.push(message) }
    const { session } = await open(h)
    assert.deepEqual((await h.events('argv')).map(e => e.argv), [['acp', '--log-level', 'warn']])
    assert.deepEqual(await childEnv(h), [{ CODEX_PATH: null, CLAUDE_CODE_EXECUTABLE: null, INITIAL_AGENT_MODE: null }])
    assert.match(session, /^opencode_/)
    assert.deepEqual((await h.events('new')).map(e => e.meta), [null])
    assert.ok(logs.every(l => !l.includes('ignores args')))
  }))

  test('U152 opencode below the minimum, V1 included, is AGENT_VERSION_UNSUPPORTED', () => withHarness({ adapter: 'opencode' }, async h => {
    h.config.subagents.agent.path = await fakeProgram(join(h.dir, 'old-opencode'), 'opencode v2.0.1')
    await assert.rejects(open(h), rejectsWith('AGENT_VERSION_UNSUPPORTED', /opencode 2\.0\.1 .*2\.0\.30/))
    h.config.subagents.agent.path = await fakeProgram(join(h.dir, 'v1-opencode'), '1.19.3')
    await assert.rejects(open(h), rejectsWith('AGENT_VERSION_UNSUPPORTED', /opencode 1\.19\.3 .*2\.0\.30/))
    assert.equal((await h.events('start')).length, 0)
  }))

  test('U153 initial config: model, effort, then mode, before the role prompt', () => withHarness({
    adapter: 'opencode',
    subagent: { model: 'openai/m', reasoning_effort: 'low', mode: 'plan' },
    scripts: { agent: { configOptions: opencodeOptions } },
  }, async h => {
    const logs: string[] = []
    h.host.log = (message: string) => { logs.push(message) }
    await open(h)
    assert.deepEqual(await setConfigs(h), [['model', 'openai/m'], ['effort', 'low'], ['mode', 'plan']])
    const order = (await h.log()).filter(e => e.event === 'set_config' || e.event === 'prompt').map(e => e.event)
    assert.deepEqual(order, ['set_config', 'set_config', 'set_config', 'prompt'])
    assert.ok(logs.every(l => !l.includes('ignores mode')))
  }))

  test('U154 approve and reject pick once and reject', () => withHarness({
    adapter: 'opencode',
    scripts: { agent: { turns: [[opencodeBash('ls', 'a'), opencodeBash('rm x', 'b'), { chunk: 'end' }]] } },
  }, async h => {
    const { session } = await open(h)
    const first = await h.manager.prompt(session, 'go', true)
    const second = await h.manager.respond('approve', session, first.approval?.approval_id ?? '', undefined, true)
    const done = await h.manager.respond('reject', session, second.approval?.approval_id ?? '', undefined, true)
    assert.equal(done.status, 'done')
    const answered = (await h.events('permission')).map(e => e.outcome)
    assert.deepEqual(answered, [{ outcome: 'selected', optionId: 'once' }, { outcome: 'selected', optionId: 'reject' }])
  }))

  test('U155 allow answers once and matches the exact command, never always', () => withHarness({
    adapter: 'opencode',
    scripts: { agent: { turns: [[opencodeBash('npm test', 'a'), opencodeBash('npm test', 'b'), opencodeBash('npm test -- x', 'c')]] } },
  }, async h => {
    const { session } = await open(h)
    const first = await h.manager.prompt(session, 'go', true)
    const next = await h.manager.respond('allow', session, first.approval?.approval_id ?? '', undefined, true)
    assert.equal(next.status, 'approval_needed')
    assert.equal(next.approval?.title, 'npm test -- x')
    const answered = (await h.events('permission')).map(e => [e.title, e.outcome])
    assert.deepEqual(answered, [
      ['npm test#a', { outcome: 'selected', optionId: 'once' }],
      ['npm test#b', { outcome: 'selected', optionId: 'once' }],
    ])
  }))

  test('U157 auth_required points at opencode auth login and OPENCODE_CONFIG, without calling authenticate', () => withHarness({ adapter: 'opencode', scripts: { agent: { authRequired: true } } }, async h => {
    await assert.rejects(open(h), rejectsWith('AUTH_REQUIRED', /opencode auth login.*OPENCODE_CONFIG/))
    assert.equal((await h.events('authenticate')).length, 0)
  }))
})

describe('antigravity adapter', () => {
  const STREAM_JSON = ['--input-format', 'stream-json', '--output-format', 'stream-json']
  const agyText = (index: number, text: string) => ({ step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: text })
  const agyTool = (index: number, name: string, state: string, info: Record<string, unknown>) => ({ step_index: index, state, step_type: 'tool', tool_name: name, tool_info: info })
  // Each `agy -p` process logs one argv entry; ppid is the bridge
  const agyRuns = (h: Harness) => h.events('argv')
  const processesOf = async (h: Harness) => (await agyRuns(h)).flatMap(e => [Number(e.pid), Number(e.ppid)])
  const allGone = async (h: Harness, label: string) => {
    const pids = await processesOf(h)
    await until(() => pids.every(p => !isAlive(p)), 5000, label)
  }
  const entriesOf = async (h: Harness, pid: unknown) => (await h.log()).filter(e => e.pid === pid).map(e => e.event)
  const toolCalls = (h: Harness, session: string) => (h.manager.snapshot({}).sessions.find(s => s.session === session)?.events ?? [])
    .reduce((calls, e) => (e.tool_call ? calls.set(e.tool_call.tool_call_id, e.tool_call) : calls), new Map<string, ToolCallView>())
  // Wrapped in an object: an async function returning the promise itself would wait for the whole turn
  const startTurn = async (h: Harness, session: string, text: string) => {
    const pending = h.manager.prompt(session, text, true)
    await until(async () => (await h.events('input')).some(e => e.text === text), 5000, `${text} reaches agy`)
    return { pending }
  }

  test('U185 agy runs with stream-json, config flags, --conversation, args, then -p=', () => withHarness({
    adapter: 'antigravity',
    subagent: { mode: 'plan', args: ['--dangerously-skip-permissions'] },
    agy: { conversation_id: 'c-1' },
  }, async h => {
    const { session } = await open(h)
    assert.equal(session, 'antigravity_c-1')
    const runs = await agyRuns(h)
    assert.deepEqual(runs.map(e => e.argv), [
      [...STREAM_JSON, '--dangerously-skip-permissions', '-p='],
      [...STREAM_JSON, '--mode', 'plan', '--conversation', 'c-1', '--dangerously-skip-permissions', '-p='],
    ])
    assert.deepEqual(runs[1].env, { AGY_PATH: h.config.subagents.agent.path, CODEX_PATH: null, CLAUDE_CODE_EXECUTABLE: null })
  }))

  test('U186 text and tool steps become messages and tool calls; no config, no restart', () => withHarness({
    adapter: 'antigravity',
    agy: {
      turns: [{
        match: '^go$',
        steps: [
          agyText(1, 'Hel'), agyText(1, 'lo'),
          agyTool(2, 'run_command', 'ACTIVE', { parameters: { CommandLine: 'ls -la' } }),
          agyTool(2, 'run_command', 'DONE', { output: 'a.txt' }),
          agyText(3, 'Bye'), agyText(3, '!'),
          agyTool(4, 'read_file', 'ACTIVE', { parameters: { AbsolutePath: '/nope' } }),
          agyTool(4, 'read_file', 'ERROR', { error: { message: 'no such file' } }),
        ],
      }],
    },
  }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    assert.deepEqual([r.status, r.outcome, r.output], ['done', 'done', 'Hello\n\nBye!'])
    const calls = toolCalls(h, session)
    assert.deepEqual([calls.get('step-2')?.kind, calls.get('step-2')?.status], ['execute', 'completed'])
    assert.match(calls.get('step-2')?.title ?? '', /^run_command ls -la/)
    assert.deepEqual([calls.get('step-4')?.kind, calls.get('step-4')?.status], ['read', 'failed'])
    assert.equal((await agyRuns(h)).length, 1)
  }))

  test('U187 denied actions end the turn with a note, never an approval', () => withHarness({
    adapter: 'antigravity',
    agy: { turns: [{ match: '^go$', result: { response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }] },
  }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    assert.deepEqual([r.status, r.outcome], ['done', 'done'])
    assert.match(r.output ?? '', /agy denied in headless mode: RunCommand/)
    assert.match(r.output ?? '', /permissions\.allow/)
  }))

  test('U188 cancel: the interrupted agy is never reused, the next turn continues the conversation', () => withHarness({
    adapter: 'antigravity',
    agy: { conversation_id: 'c-1', turns: [{ match: '^go$', hang: true }] },
  }, async h => {
    const { session } = await open(h)
    const { pending } = await startTurn(h, session, 'go')
    h.manager.cancel(session)
    assert.equal((await pending).outcome, 'cancelled')
    assert.equal(h.manager.status(session).state, 'IDLE')
    const next = await h.manager.prompt(session, 'again', true)
    assert.equal(next.status, 'done')
    const runs = await agyRuns(h)
    assert.equal(runs.length, 2)
    assert.deepEqual(runs[1].argv, [...STREAM_JSON, '--conversation', 'c-1', '-p='])
    const first = await entriesOf(h, runs[0].pid)
    assert.deepEqual(first.slice(first.indexOf('sigint')), ['sigint', 'exit'])
  }))

  test('U188 cancel while agy restarts returns cancelled and keeps the new agy', () => withHarness({
    adapter: 'antigravity',
    agy: { conversation_id: 'c-1', resume_init_delay_ms: 2000, turns: [{ match: '^go$', hang: true }] },
  }, async h => {
    const { session } = await open(h)
    const { pending } = await startTurn(h, session, 'go')
    h.manager.cancel(session)
    await pending
    const again = h.manager.prompt(session, 'again', true)
    await until(async () => (await agyRuns(h)).length === 2, 5000, 'agy restarting')
    h.manager.cancel(session)
    const r = await again
    assert.deepEqual([r.status, r.outcome], ['done', 'cancelled'])
    const third = await h.manager.prompt(session, 'third', true)
    assert.equal(third.status, 'done')
    const runs = await agyRuns(h)
    assert.equal(runs.length, 2)
    const second = await h.log()
    assert.deepEqual(second.filter(e => e.pid === runs[1].pid && e.event !== 'argv').map(e => [e.event, e.text ?? null]), [['input', 'third']])
  }))

  test('U189 config options come from agy models; values become flags on the next turn', () => withHarness({
    adapter: 'antigravity',
    subagent: { model: 'gemini-3.8-flash', reasoning_effort: 'high' },
  }, async h => {
    const opened = await open(h)
    const option = (options: typeof opened.config_options, id: string) => options.find(o => o.id === id)
    assert.deepEqual(option(opened.config_options, 'model')?.options.map(o => o.value), ['default', 'gemini-3.8-flash', 'gpt-oss-120b'])
    assert.equal(option(opened.config_options, 'model')?.current_value, 'gemini-3.8-flash')
    assert.deepEqual(option(opened.config_options, 'reasoning_effort')?.options.map(o => o.value), ['default', 'low', 'high'])
    assert.equal(option(opened.config_options, 'reasoning_effort')?.current_value, 'high')
    const runs = await agyRuns(h)
    assert.deepEqual(runs[1].argv, [...STREAM_JSON, '--model', 'gemini-3.8-flash', '--effort', 'high', '--conversation', opened.session.replace(/^antigravity_/, ''), '-p='])
    const changed = await h.manager.setConfig(opened.session, 'model', 'gpt-oss-120b')
    assert.equal(option(changed, 'reasoning_effort')?.current_value, 'default')
    assert.deepEqual(option(changed, 'reasoning_effort')?.options.map(o => o.value), ['default', 'medium'])
    await assert.rejects(h.manager.setConfig(opened.session, 'mode', 'yolo'), { code: 'INVALID_OPTION' })
  }))

  test('U190 close then reconnect resumes the conversation without replay', () => withHarness({ adapter: 'antigravity' }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'hi', true)
    await h.manager.close(session)
    await open(h, { session })
    const runs = await agyRuns(h)
    assert.deepEqual(runs.at(-1)?.argv, [...STREAM_JSON, '--conversation', session.replace(/^antigravity_/, ''), '-p='])
    const events = h.manager.snapshot({}).sessions.find(s => s.session === session)?.events ?? []
    assert.equal(events.some(e => e.replay), false)
    assert.equal((await h.manager.prompt(session, 'again', true)).status, 'done')
  }))

  test('U191 a conversation agy does not know is not found, on reconnect and on an internal restart', () => withHarness({
    adapter: 'antigravity',
    agy: { turns: [{ match: '^go$', hang: true }] },
  }, async h => {
    const { session: closed } = await open(h)
    await h.manager.close(closed)
    await h.setAgy({ unknown_conversation: true, turns: [{ match: '^go$', hang: true }] })
    await assert.rejects(open(h, { session: closed }), rejectsWith('AGENT_ERROR', /not found/))
    assert.equal(await readFile(join(h.home, 'sessions', closed, 'lock.pid')).then(() => true, () => false), false)
    await allGone(h, 'reconnect processes exit')

    const { session } = await open(h)
    const { pending } = await startTurn(h, session, 'go')
    h.manager.cancel(session)
    await pending
    await assert.rejects(h.manager.prompt(session, 'again', true), rejectsWith('AGENT_ERROR', /not found/))
    assert.equal(h.manager.status(session).state, 'IDLE')
    const restarted = (await agyRuns(h)).at(-1)
    assert.ok(restarted?.argv.includes('--conversation'))
    await until(() => !isAlive(Number(restarted?.pid)), 5000, 'restarted agy exits')
    assert.equal((await h.events('input')).some(e => e.text === 'again'), false)
  }))

  test('U192 not logged in is AUTH_REQUIRED and leaves no process', () => withHarness({ adapter: 'antigravity', agy: { auth_error: true } }, async h => {
    await assert.rejects(open(h), rejectsWith('AUTH_REQUIRED', /Run `agy`/))
    await allGone(h, 'bridge and fake agy exit')
  }))

  test('U193 agy errors reach AGENT_ERROR with their reason; the session goes on', () => withHarness({
    adapter: 'antigravity',
    agy: { turns: [{ match: '^crash$', crash: true }, { match: '^quota$', result: { status: 'ERROR', error: 'quota exceeded' } }] },
  }, async h => {
    const { session } = await open(h)
    await assert.rejects(h.manager.prompt(session, 'crash', true), rejectsWith('AGENT_ERROR', /agy exited with code 3/))
    assert.equal(h.manager.status(session).state, 'IDLE')
    assert.equal((await h.manager.prompt(session, 'again', true)).status, 'done')
    assert.equal((await agyRuns(h)).length, 2)
    await assert.rejects(h.manager.prompt(session, 'quota', true), rejectsWith('AGENT_ERROR', /quota exceeded/))
  }))

  test('U195 close ends an idle agy', () => withHarness({ adapter: 'antigravity' }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await allGone(h, 'bridge and fake agy exit')
  }))

  for (const how of ['close', 'SIGTERM'] as const) {
    test(`U195 ${how} during a turn agy ignores SIGINT on: the bridge kills agy before it goes`, () => withHarness({
      adapter: 'antigravity',
      agy: { turns: [{ match: '^go$', hang: true, ignore_sigint: true }] },
    }, async h => {
      const { session } = await open(h)
      await h.manager.prompt(session, 'go', false)
      await until(async () => (await h.events('input')).some(e => e.text === 'go'), 5000, 'go reaches agy')
      const [run] = await agyRuns(h)
      how === 'close' ? await h.manager.close(session) : process.kill(Number(run.ppid), 'SIGTERM')
      await allGone(h, 'bridge and fake agy exit')
      const events = await entriesOf(h, run.pid)
      assert.ok(events.includes('sigint'))
      assert.equal(events.includes('exit'), false)
    }))
  }

  test('U195 close while the bridge waits for the old agy to stop starts no new agy', () => withHarness({
    adapter: 'antigravity',
    agy: { stdin_exit_delay_ms: 1000 },
  }, async h => {
    const { session } = await open(h)
    await h.manager.setConfig(session, 'mode', 'plan')
    await h.manager.prompt(session, 'go', false)
    await sleep(300)
    await h.manager.close(session)
    await allGone(h, 'bridge and fake agy exit')
    await sleep(1500)
    assert.equal((await agyRuns(h)).length, 1)
  }))

  test('U196 agy models failing leaves only the default model', () => withHarness({ adapter: 'antigravity', agy: { models: null } }, async h => {
    const server = await spawnServer(h.home)
    const err = { text: '' }
    server.transport.stderr?.on('data', (c: Buffer) => { err.text += c.toString() })
    try {
      const opened = await server.call('open', { subagent: 'agent', cwd: h.dir })
      assert.equal(opened.isError, false, JSON.stringify(opened.data))
      const options: ConfigOptionInfo[] = JSON.parse(JSON.stringify(opened.data.config_options))
      assert.deepEqual(options.find(o => o.id === 'model')?.options.map(o => o.value), ['default'])
      await until(() => /agy models failed/.test(err.text), 5000, 'models failure logged')
    } finally {
      await server.close()
    }
  }))

  test('U197 a non-JSON line from agy is logged and dropped; ACP keeps working', () => withHarness({
    adapter: 'antigravity',
    agy: { turns: [{ match: '^go$', raw: ['Warning: something odd'], steps: [agyText(1, 'fine')] }] },
  }, async h => {
    const server = await spawnServer(h.home)
    const err = { text: '' }
    server.transport.stderr?.on('data', (c: Buffer) => { err.text += c.toString() })
    try {
      const { data } = await server.call('open', { subagent: 'agent', cwd: h.dir })
      const done = await server.call('prompt', { session: data.session, text: 'go' })
      assert.deepEqual([done.data.status, done.data.output], ['done', 'fine'])
      assert.match(err.text, /\[agy-acp\] ignored: Warning: something odd/)
    } finally {
      await server.close()
    }
  }))
})

/** A form with a single select, a multi select, a number and a boolean field. */
const FORM: acp.ElicitationSchema = {
  type: 'object',
  properties: {
    q0: { type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] },
    m: { type: 'array', items: { anyOf: [{ const: 'x', title: 'X' }, { const: 'y', title: 'Y' }] } },
    n: { type: 'number', minimum: 0 },
    b: { type: 'boolean' },
  },
  required: ['q0'],
}

const answers = async (h: Harness) => (await h.events('question')).map(e => e.response ?? { error: e.error })
const eventTypes = (h: Harness, session: string) => h.manager.snapshot({}).sessions.find(s => s.session === session)?.events ?? []

describe('questions', () => {
  // The sleep keeps the turn running after an answer, so a cancel always reaches it
  const questioning = { scripts: { agent: { turns: [[{ question: { message: 'Pick', schema: FORM, toolCallId: 'call-1' } }, { sleep: 300 }, { chunk: 'after' }]] } } }

  test('U158 initialize advertises form elicitation only', () => withHarness({}, async h => {
    await open(h)
    const [{ capabilities }] = await h.events('initialize')
    assert.ok(capabilities && typeof capabilities === 'object')
    const { fs, terminal, elicitation } = Object.fromEntries(Object.entries(capabilities))
    assert.deepEqual({ fs, terminal, elicitation }, { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } })
  }))

  test('U159 question_needed passes the form on as sent', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    assert.equal(r.status, 'question_needed')
    assert.match(r.question?.question_id ?? '', /^qu_\d+$/)
    assert.equal(r.question?.message, 'Pick')
    assert.equal(r.question?.tool_call_id, 'call-1')
    assert.deepEqual(r.question?.requested_schema, FORM)
    assert.equal(h.manager.status(session).state, 'QUESTIONING')
    assert.equal(h.manager.status(session).questions.length, 1)
  }))

  test('U160 answer passes content to the agent unchanged', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const content = { q0: 'red', n: 3, b: true, m: ['x'] }
    const done = await h.manager.answer(session, r.question?.question_id ?? '', 'accept', content, true)
    assert.equal(done.status, 'done')
    assert.equal(done.output, 'after')
    assert.deepEqual(await answers(h), [{ action: 'accept', content }])
  }))

  test('U161 decline and cancel carry no content', () => withHarness({
    scripts: { agent: { turns: [[{ question: { message: 'A' } }, { question: { message: 'B' } }, { chunk: 'after' }]] } },
  }, async h => {
    const { session } = await open(h)
    const a = await h.manager.prompt(session, 'go', true)
    const b = await h.manager.answer(session, a.question?.question_id ?? '', 'decline', { q0: 'red' }, true)
    assert.equal(b.question?.message, 'B')
    assert.equal((await h.manager.answer(session, b.question?.question_id ?? '', 'cancel', undefined, true)).status, 'done')
    assert.deepEqual(await answers(h), [{ action: 'decline' }, { action: 'cancel' }])
  }))

  test('U162 accept without content sends an empty object', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    await h.manager.answer(session, r.question?.question_id ?? '', 'accept', undefined, true)
    assert.deepEqual(await answers(h), [{ action: 'accept', content: {} }])
  }))

  test('U163 answering twice answers once; an id never issued is INVALID_OPTION', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const id = r.question?.question_id ?? ''
    await h.manager.answer(session, id, 'accept', { q0: 'red' }, true)
    const again = await h.manager.answer(session, id, 'accept', { q0: 'blue' }, true)
    assert.equal(again.status, 'done')
    assert.equal((await answers(h)).length, 1)
    await assert.rejects(h.manager.answer(session, 'qu_999', 'accept', undefined, true), { code: 'INVALID_OPTION' })
  }))

  test('U164 approval and question ids do not mix', () => withHarness({
    scripts: { agent: { turns: [[{ parallel: [{ permission: {} }, { question: { message: 'Q' } }] }]] } },
  }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).approvals.length === 1 && h.manager.status(session).questions.length === 1, 5000, 'both pending')
    const { approvals: [approval], questions: [question] } = h.manager.status(session)
    await assert.rejects(h.manager.respond('approve', session, question.question_id, undefined, true), { code: 'INVALID_OPTION' })
    await assert.rejects(h.manager.answer(session, approval.approval_id, 'accept', undefined, true), { code: 'INVALID_OPTION' })
    assert.equal(h.manager.status(session).approvals.length, 1)
    assert.equal(h.manager.status(session).questions.length, 1)
  }))

  test('U165 an approval comes before a question that arrived first', () => withHarness({
    scripts: { agent: { turns: [[{ parallel: [{ question: { message: 'Q' } }, { later: { ms: 50, step: { permission: {} } } }] }, { chunk: 'after' }]] } },
  }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).approvals.length === 1 && h.manager.status(session).questions.length === 1, 5000, 'both pending')
    assert.equal(h.manager.status(session).state, 'ASKING')
    const asked = await h.manager.prompt(session, 'again', true)
    assert.equal(asked.status, 'approval_needed')
    const questioned = await h.manager.respond('approve', session, asked.approval?.approval_id ?? '', undefined, true)
    assert.equal(questioned.status, 'question_needed')
    assert.equal(h.manager.status(session).state, 'QUESTIONING')
    assert.equal((await h.manager.answer(session, questioned.question?.question_id ?? '', 'accept', { q0: 'red' }, true)).status, 'done')
  }))

  test('U166 a question handed out before an approval can still be answered', () => withHarness({
    scripts: { agent: { turns: [[{ parallel: [{ question: { message: 'Q' } }, { later: { ms: 300, step: { permission: {} } } }] }, { sleep: 1500 }]] } },
  }, async h => {
    const { session } = await open(h)
    const questioned = await h.manager.prompt(session, 'go', true)
    assert.equal(questioned.status, 'question_needed')
    await until(() => h.manager.status(session).approvals.length === 1, 5000, 'approval')
    const asked = await h.manager.answer(session, questioned.question?.question_id ?? '', 'accept', { q0: 'blue' }, true)
    assert.equal(asked.status, 'approval_needed')
    await until(async () => (await answers(h)).length === 1, 5000, 'answer logged')
    assert.deepEqual(await answers(h), [{ action: 'accept', content: { q0: 'blue' } }])
  }))

  test('U167 cancel in QUESTIONING answers cancel, then sends session/cancel', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    assert.deepEqual(h.manager.cancel(session), { status: 'cancelling' })
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    const wire = await h.events('wire')
    const answered = wire.findIndex(e => e.action === 'cancel')
    const cancel = wire.findIndex(e => e.method === 'session/cancel')
    assert.ok(answered >= 0 && answered < cancel, JSON.stringify(wire))
  }))

  test('U168 close answers a pending question with cancel', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    await h.manager.close(session)
    await until(async () => (await answers(h)).length === 1, 5000, 'answer logged')
    assert.deepEqual(await answers(h), [{ action: 'cancel' }])
    const pids = (await h.events('start')).map(e => Number(e.pid))
    await until(() => pids.every(p => !isAlive(p)), 5000, 'agent exits')
    assert.equal((await h.manager.list())[0].state, 'CLOSED')
  }))

  test('U168 an exit while QUESTIONING clears the pending question', () => withHarness({
    scripts: { agent: { turns: [[{ parallel: [{ question: { message: 'Q' } }, { later: { ms: 300, step: { exit: 1 } } }] }]] } },
  }, async h => {
    const { session } = await open(h)
    assert.equal((await h.manager.prompt(session, 'go', true)).status, 'question_needed')
    await until(async () => (await h.manager.list())[0].state === 'CLOSED', 5000, 'CLOSED')
    assert.equal(h.manager.snapshot({}).sessions.length, 0)
    assert.throws(() => h.manager.status(session), { code: 'SESSION_NOT_FOUND' })
  }))

  test('U170 a URL-mode question gets Invalid params and never queues', () => withHarness({
    scripts: { agent: { turns: [[{ question: { message: 'Open this', mode: 'url' } }, { chunk: 'after' }]] } },
  }, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    assert.equal(r.status, 'done')
    assert.equal(r.output, 'after')
    assert.deepEqual(await answers(h), [{ error: -32602 }])
    assert.ok(eventTypes(h, session).some(e => e.type === 'question_declined' && e.text === 'Open this'))
    assert.ok(!eventTypes(h, session).some(e => e.type === 'question'))
  }))

  test('U176 questions outside a turn are cancelled at once', () => withHarness({
    scripts: {
      agent: {
        setup: [{ question: { message: 'Setup' } }, { question: { message: 'Scoped', scope: 'request' } }],
        turns: [[{ chunk: 'x' }, { later: { ms: 100, step: { question: { message: 'Late' } } } }]],
      },
    },
  }, async h => {
    const { session } = await open(h)
    assert.deepEqual(await answers(h), [{ action: 'cancel' }, { action: 'cancel' }])
    assert.equal((await h.manager.prompt(session, 'go', true)).status, 'done')
    await until(async () => (await answers(h)).length === 3, 5000, 'late question answered')
    assert.deepEqual((await answers(h))[2], { action: 'cancel' })
    assert.equal(h.manager.status(session).state, 'IDLE')
    assert.equal(h.manager.status(session).questions.length, 0)
    assert.ok(eventTypes(h, session).some(e => e.type === 'question_declined' && e.text === 'Late'))
  }))

  test('U182 two questions are handed out in arrival order', () => withHarness({
    scripts: { agent: { turns: [[{ parallel: [{ question: { message: 'First' } }, { question: { message: 'Second' } }] }, { chunk: 'after' }]] } },
  }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).questions.length === 2, 5000, 'two questions')
    const notices = () => h.manager.snapshot({}).sessions[0].notifications.filter(n => n.type === 'question').map(n => n.question?.message)
    assert.deepEqual(h.manager.status(session).questions.map(q => q.message), ['First', 'Second'])
    assert.deepEqual(notices(), ['First', 'Second'])
    const first = await h.manager.prompt(session, 'again', true)
    assert.equal(first.question?.message, 'First')
    assert.deepEqual(notices(), ['Second'])
    const second = await h.manager.answer(session, first.question?.question_id ?? '', 'accept', { q0: 'red' }, true)
    assert.equal(second.question?.message, 'Second')
    assert.equal((await h.manager.answer(session, second.question?.question_id ?? '', 'accept', { q0: 'blue' }, true)).status, 'done')
    assert.deepEqual((await h.events('question')).map(e => [e.message, e.response]), [
      ['First', { action: 'accept', content: { q0: 'red' } }],
      ['Second', { action: 'accept', content: { q0: 'blue' } }],
    ])
  }))
})

describe('execution feedback', () => {
  const entry = (content: string, status: acp.PlanEntryStatus): acp.PlanEntry => ({ content, priority: 'medium', status, _meta: { extra: true } })

  test('U171 plan keeps the latest list; each update is an event', () => withHarness({
    scripts: {
      agent: {
        turns: [[
          { update: { sessionUpdate: 'plan', entries: [entry('a', 'in_progress'), entry('b', 'pending'), entry('c', 'pending')] } },
          { update: { sessionUpdate: 'plan', entries: [entry('a', 'completed'), entry('b', 'in_progress')] } },
        ]],
      },
    },
  }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    assert.deepEqual(h.manager.progress(session).plan, [
      { content: 'a', priority: 'medium', status: 'completed' },
      { content: 'b', priority: 'medium', status: 'in_progress' },
    ])
    assert.deepEqual(eventTypes(h, session).filter(e => e.type === 'plan').map(e => e.plan?.length), [3, 2])
    assert.ok(!('plan' in h.manager.status(session)))
  }))

  test('U172 usage keeps the latest value and is never an event', () => withHarness({
    scripts: {
      agent: {
        turns: [[
          ...Array.from({ length: 9 }, (_, i): Step => ({ update: { sessionUpdate: 'usage_update', used: i, size: 1000 } })),
          { update: { sessionUpdate: 'usage_update', used: 9, size: 1000, cost: { amount: 0.5, currency: 'USD' } } },
        ]],
      },
    },
  }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    assert.deepEqual(h.manager.progress(session).usage, { used: 9, size: 1000, cost: { amount: 0.5, currency: 'USD' } })
    assert.ok(!eventTypes(h, session).some(e => e.type === 'usage_update'))
  }))

  test('U174 mode and command updates', () => withHarness({
    scripts: {
      agent: {
        turns: [[
          { update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } },
          { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'files' } }] } },
        ]],
      },
    },
  }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    assert.ok(eventTypes(h, session).some(e => e.type === 'mode' && e.text === 'plan'))
    assert.ok(eventTypes(h, session).some(e => e.type === 'commands'))
    assert.deepEqual(h.manager.progress(session).commands, [{ name: 'review', description: 'Review changes' }])
  }))
})

describe('activity', () => {
  /** `<direction> <method>` of each mirrored message; a response shows as `result` */
  const wireOf = (seen: SessionActivity[]) => ofKind(seen, 'acp').map(({ direction, message }) => `${direction} ${'method' in message ? message.method : 'result'}`)
  const titled = (title: string): Step => ({ update: { sessionUpdate: 'session_info_update', title } })

  test('U199 every ACP message is mirrored both ways, unchanged and in order', () => withHarness({
    scripts: {
      agent: {
        turns: [[
          { chunk: 'a', messageId: 'm1' },
          { chunk: 'b', messageId: 'm1' },
          { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } },
          { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: '/x.ts', oldText: 'a', newText: 'b' }], _meta: { vendor: { k: 1 } } } },
          { update: { sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'high', status: 'pending' }] } },
          { notify: { method: '_x.ai/test', params: { n: 1 } } },
          { permission: {} },
          { chunk: 'end' },
        ]],
      },
    },
  }, async h => {
    const seen = recordActivity(h.manager)
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    await h.manager.respond('approve', session, r.approval?.approval_id ?? '', undefined, true)
    const mirrored = (direction: 'in' | 'out') => ofKind(seen, 'acp').filter(a => a.direction === direction).map(a => a.message)
    const logged = async (event: string) => (await h.events(event)).map(e => e.message)
    await until(async () => (await logged('raw_in')).length === mirrored('out').length, 5000, 'raw_in')
    assert.deepEqual(mirrored('in'), await logged('raw_out'))
    assert.deepEqual(mirrored('out'), await logged('raw_in'))
    assert.ok(wireOf(seen).includes('in _x.ai/test'))
  }))

  test('U200 activity while opening follows session_opened in order; a failed open has none', async () => {
    await withHarness({ scripts: { agent: { sessionId: 's-1', replay: ['h1'], setup: [titled('T')] } } }, async h => {
      const seen = recordActivity(h.manager)
      const { session } = await open(h)
      await h.manager.close(session)
      const created = seen.splice(0)
      const [first] = ofKind(created, 'session_opened')
      assert.equal(created[0].activity, first)
      assert.deepEqual([created[0].session, first.subagent, first.adapter, first.cwd, first.title, first.reconnected], [session, 'agent', 'codex', h.dir, 'T', false])
      assert.deepEqual(wireOf(created).slice(0, 5), ['out initialize', 'in result', 'out session/new', 'in session/update', 'in result'])
      await open(h, { session })
      assert.equal(seen[0].activity.kind === 'session_opened' && seen[0].activity.reconnected, true)
      assert.deepEqual(wireOf(seen).slice(0, 6), ['out initialize', 'in result', 'out session/load', 'in session/update', 'in session/update', 'in result'])
    })
    await withHarness({ scripts: { agent: { authRequired: true } } }, async h => {
      const seen = recordActivity(h.manager)
      await assert.rejects(open(h), { code: 'AUTH_REQUIRED' })
      assert.deepEqual(seen, [])
    })
  })

  test('U201 approvals report how they were resolved; ones an allow covers are auto_approved', () => withHarness({
    scripts: { agent: { turns: [['A', 'B', 'B', 'C', 'D'].map((title): Step => ({ permission: { title } })).concat({ sleep: 300 })] } },
  }, async h => {
    const seen = recordActivity(h.manager)
    const { session } = await open(h)
    const a = await h.manager.prompt(session, 'go', true)
    const b = await h.manager.respond('approve', session, a.approval?.approval_id ?? '', undefined, true)
    const c = await h.manager.respond('allow', session, b.approval?.approval_id ?? '', undefined, true)
    const d = await h.manager.respond('reject', session, c.approval?.approval_id ?? '', undefined, true)
    assert.equal(d.approval?.title, 'D')
    h.manager.cancel(session)
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    const ids = [a, b, c, d].map(r => r.approval?.approval_id)
    assert.deepEqual(ofKind(seen, 'approval').map(x => [x.approval_id, x.tool_call_id]), ids.map((id, i) => [id, `call-${'ABCD'[i]}`]))
    assert.deepEqual(ofKind(seen, 'approval_resolved').map(x => [x.approval_id, x.resolution, x.option_id]), [
      [ids[0], 'approve', 'opt-allow_once'],
      [ids[1], 'allow', 'opt-allow_once'],
      [ids[2], 'reject', 'opt-reject_once'],
      [ids[3], 'cancelled', null],
    ])
    assert.deepEqual(ofKind(seen, 'auto_approved').map(x => [x.tool_call_id, x.option_id]), [['call-B', 'opt-allow_once']])
  }))

  test('U202 questions report the answer; one while IDLE leaves only the ACP messages', () => withHarness({
    scripts: { agent: { turns: [[{ question: { message: 'A' } }, { question: { message: 'B' } }, { question: { message: 'C' } }, { chunk: 'x' }, { later: { ms: 200, step: { question: { message: 'Late' } } } }]] } },
  }, async h => {
    const seen = recordActivity(h.manager)
    const { session } = await open(h)
    const a = await h.manager.prompt(session, 'go', true)
    const b = await h.manager.answer(session, a.question?.question_id ?? '', 'accept', { q0: 'red' }, true)
    const c = await h.manager.answer(session, b.question?.question_id ?? '', 'decline', undefined, true)
    assert.equal((await h.manager.answer(session, c.question?.question_id ?? '', 'cancel', undefined, true)).status, 'done')
    await until(async () => (await h.events('question')).some(e => e.message === 'Late'), 5000, 'late question')
    const ids = [a, b, c].map(r => r.question?.question_id)
    assert.deepEqual(ofKind(seen, 'question').map(x => x.question_id), ids)
    assert.deepEqual(ofKind(seen, 'question_resolved').map(x => [x.question_id, x.action]), [[ids[0], 'accept'], [ids[1], 'decline'], [ids[2], 'cancel']])
    const late = ofKind(seen, 'acp').map(x => x.message).filter(m => 'method' in m && m.method === 'elicitation/create').at(-1)
    assert.ok(late && 'id' in late)
    const reply = ofKind(seen, 'acp').find(x => x.direction === 'out' && 'id' in x.message && x.message.id === late.id && !('method' in x.message))
    assert.deepEqual(reply?.message && 'result' in reply.message ? reply.message.result : null, { action: 'cancel' })
  }))

  test('U203 turns are marked internal or not; state changes are reported once each', () => withHarness({ scripts: { agent: { turns: [[{ permission: {} }, { chunk: 'x' }]] } } }, async h => {
    const seen = recordActivity(h.manager)
    const { session } = await open(h, { role: 'Reviewer' })
    const r = await h.manager.prompt(session, 'go', true)
    await h.manager.respond('approve', session, r.approval?.approval_id ?? '', undefined, true)
    const started = ofKind(seen, 'turn_started')
    assert.deepEqual(started.map(t => t.internal), [true, false])
    assert.deepEqual(ofKind(seen, 'turn_finished').map(t => [t.turn_id, t.outcome, t.error]), started.map(t => [t.turn_id, 'done', null]))
    const states = ofKind(seen, 'state').map(s => `${s.state}:${s.cancelling}`)
    assert.ok(states.every((s, i) => s !== states[i - 1]), states.join(' '))
    const second = seen.findIndex(s => s.activity === started[1])
    assert.deepEqual(ofKind(seen.slice(second), 'state').map(s => s.state), ['RUNNING', 'ASKING', 'RUNNING', 'IDLE'])
  }))
})
