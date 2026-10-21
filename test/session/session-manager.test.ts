import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../../src/adapter/adapter'
import { loadConfig, resolveSubagent } from '../../src/config'
import { NodeHost } from '../../src/host/node-host'
import { SessionManager } from '../../src/session/session-manager'
import type { SessionActivity } from '../../src/session/session-manager'
import type { OpenParams } from '../../src/types'
import { isAlive, recordActivity, setup, sleep, SlowWriteHost, spawnServer, until } from '../fixtures/harness'
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
const sessionDir = (h: Harness, id: string) => join(h.home, 'sessions', id)
const lockFile = (h: Harness, id: string) => join(sessionDir(h, id), 'lock.pid')
const exists = (path: string) => readFile(path).then(() => true, () => false)
const agentPids = async (h: Harness) => (await h.events('start')).map(e => Number(e.pid))

function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  return pid ?? 999_999
}

describe('config', () => {
  test('U1 first load creates the default config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-config-'))
    try {
      const config = await loadConfig(new NodeHost(), home)
      const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'))
      assert.equal('max_wait' in saved, false)
      assert.deepEqual(saved.idle, { timeout: 0 })
      assert.deepEqual(saved.webui, { port: 7200 })
      assert.deepEqual(config.webui, { port: 7200 })
      assert.deepEqual(saved.profiles, {})
      assert.deepEqual(Object.keys(saved.subagents), ['codex', 'claude', 'grok', 'opencode', 'antigravity'])
      assert.deepEqual(Object.keys(saved.subagents).map(name => saved.subagents[name].adapter), ['codex', 'claude', 'grok', 'opencode', 'antigravity'])
      Object.values(saved.subagents).forEach(sub => {
        assert.deepEqual([sub.path, sub.args, sub.profile], ['', [], ''])
        assert.equal('codex_path' in sub, false)
      })
      assert.equal(config.subagents.claude.adapter, 'claude')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('U2 unknown config fields are ignored', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-config-'))
    try {
      await writeFile(join(home, 'config.json'), JSON.stringify({ max_wait: 0, idle: { timeout: 60, check_interval: 30 } }))
      const config = await loadConfig(new NodeHost(), home)
      assert.equal('max_wait' in config, false)
      assert.deepEqual(config.idle, { timeout: 60 })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('open', () => {
  test('U4 new session goes OPENING then IDLE, directory holds session.json and lock.pid', () => withHarness({ scripts: { agent: { delays: { newSession: 300 } } } }, async h => {
    const adapter = createAdapter('codex', h.host)
    const pending = adapter.open({ config: resolveSubagent(h.config, 'agent'), cwd: h.dir, role: 'r', onEstablished: async () => {} })
    await sleep(50)
    assert.equal(adapter.state, 'OPENING')
    await pending
    assert.equal(adapter.state, 'IDLE')
    await adapter.close()

    const { session } = await open(h)
    assert.equal(h.manager.status(session).state, 'IDLE')
    assert.deepEqual((await readdir(sessionDir(h, session))).sort(), ['lock.pid', 'session.json'])
  }))

  test('U6 session id is codex_<native id>', () => withHarness({ scripts: { agent: { sessionId: 's-1' } } }, async h => {
    const { session } = await open(h)
    assert.equal(session, 'codex_s-1')
    assert.ok(await exists(join(sessionDir(h, 'codex_s-1'), 'session.json')))
  }))

  test('U26 reconnect uses session/load with the native id', () => withHarness({ scripts: { agent: { sessionId: 's-1' } } }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await open(h, { session })
    assert.deepEqual((await h.events('load')).map(e => e.sessionId), ['s-1'])
  }))

  test('U43 unknown subagent is SUBAGENT_NOT_FOUND', () => withHarness({}, async h => {
    await assert.rejects(h.manager.open({ subagent: 'nope', cwd: h.dir }), { code: 'SUBAGENT_NOT_FOUND' })
  }))
})

describe('profiles', () => {
  const childEnv = async (h: Harness) => (await h.events('start')).map(e => e.env)

  test('U129 profile values are the base, subagent values win', () => withHarness({
    scripts: { agent: { envKeys: ['A', 'B', 'C'] } },
    profiles: { p: { model: 'pm', role: 'PR', env: { A: '1', B: '2' }, args: ['--add-dir', '/p', '--debug'] } },
    subagent: { profile: 'p', model: 'sm', args: ['--add-dir', '/s'] },
    env: { agent: { B: '', C: '3' } },
  }, async h => {
    const resolved = resolveSubagent(h.config, 'agent')
    assert.deepEqual([resolved.model, resolved.role, resolved.args], ['sm', 'PR', ['--debug', '--add-dir', '/s']])
    await open(h)
    assert.deepEqual(await childEnv(h), [{ A: '1', B: null, C: '3' }])
  }))

  test('U130 an unknown profile is PROFILE_NOT_FOUND for that subagent only', () => withHarness({ scripts: { agent: {}, plain: {} } }, async h => {
    h.config.subagents.agent.profile = 'nope'
    await assert.rejects(open(h), { code: 'PROFILE_NOT_FOUND' })
    await h.manager.open({ subagent: 'plain', cwd: h.dir })
    assert.deepEqual(h.manager.subagents().map(s => [s.name, s.profile]), [['agent', 'nope'], ['plain', '']])
  }))

  test('U131 a profile cannot set the adapter', () => withHarness({}, async h => {
    h.config.profiles.p = JSON.parse('{"adapter": "claude"}')
    Object.assign(h.config.subagents.agent, { profile: 'p', adapter: undefined })
    assert.equal(resolveSubagent(h.config, 'agent').adapter, 'codex')
  }))

  test('U132 profile env references resolve at load', () => withHarness({ scripts: { agent: { envKeys: ['K'] } } }, async h => {
    process.env.COCKPIT_BAR = 'x'
    try {
      const configPath = join(h.home, 'config.json')
      const raw = JSON.parse(await readFile(configPath, 'utf-8'))
      raw.profiles = { p: { env: { K: '${COCKPIT_BAR}' } } }
      raw.subagents.agent.profile = 'p'
      await writeFile(configPath, JSON.stringify(raw))
      const config = await loadConfig(h.host, h.home)
      assert.equal(resolveSubagent(config, 'agent').env.K, 'x')
    } finally {
      delete process.env.COCKPIT_BAR
    }
  }))

  test('U133 subagents lists names and profiles, never config values', () => withHarness({
    profiles: { p: { env: { K: 'secret-value' } } },
    subagent: { profile: 'p' },
    env: { agent: { K2: 'secret-value' } },
  }, async h => {
    const list = h.manager.subagents()
    assert.deepEqual(list, [{ name: 'agent', adapter: 'codex', description: '', profile: 'p' }])
    assert.equal(JSON.stringify(list).includes('secret-value'), false)
  }))

  test('U135 inherited property names are not configured entries', () => withHarness({ scripts: { agent: {}, other: {} } }, async h => {
    await ['constructor', '__proto__', 'toString'].reduce(async (prev, name) => {
      await prev
      await assert.rejects(h.manager.open({ subagent: name, cwd: h.dir }), { code: 'SUBAGENT_NOT_FOUND' })
    }, Promise.resolve())
    h.config.subagents.other.profile = 'constructor'
    await assert.rejects(h.manager.open({ subagent: 'other', cwd: h.dir }), { code: 'PROFILE_NOT_FOUND' })
    h.config.profiles = JSON.parse('{"constructor": {"model": "gpt-b"}}')
    const opened = await h.manager.open({ subagent: 'other', cwd: h.dir })
    assert.equal(h.manager.status(opened.session).config.model, 'gpt-b')
  }))

  test('U136 reconnect resolves the profile again', () => withHarness({ scripts: { agent: { envKeys: ['K'] } }, profiles: { p: { env: { K: 'old' } } }, subagent: { profile: 'p' } }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    h.config.profiles.p = { env: { K: 'new' } }
    await open(h, { session })
    assert.deepEqual(await childEnv(h), [{ K: 'old' }, { K: 'new' }])
  }))

  test('U184 env values that are not strings reach the agent as text', () => withHarness({ scripts: { agent: { envKeys: ['OBJ', 'ARR', 'NUM', 'BOOL', 'GONE', 'P'] } } }, async h => {
    process.env.COCKPIT_QUOTE = 'a"b'
    try {
      const configPath = join(h.home, 'config.json')
      const raw = JSON.parse(await readFile(configPath, 'utf-8'))
      raw.profiles = { p: { env: { P: { from: 'profile', keep: true }, GONE: 'profile' } } }
      raw.subagents.agent.profile = 'p'
      raw.subagents.agent.env = {
        ...raw.subagents.agent.env,
        OBJ: { url: 'http://x/${COCKPIT_QUOTE}', list: [1, true, null] },
        ARR: ['a', 2],
        NUM: 3,
        BOOL: false,
        GONE: null,
        P: { from: 'subagent' },
      }
      await writeFile(configPath, JSON.stringify(raw))
      Object.assign(h.config, await loadConfig(h.host, h.home))
      await open(h)
      assert.deepEqual(await childEnv(h), [{
        OBJ: JSON.stringify({ url: 'http://x/a"b', list: [1, true, null] }),
        ARR: '["a",2]',
        NUM: '3',
        BOOL: 'false',
        GONE: null,
        P: '{"from":"subagent"}',
      }])
    } finally {
      delete process.env.COCKPIT_QUOTE
    }
  }))

  test('U56 setup over 30s is AGENT_ERROR, agent killed, no directory', { timeout: 60_000 }, () => withHarness({ scripts: { agent: { delays: { newSession: 40_000 } } } }, async h => {
    const started = Date.now()
    await assert.rejects(open(h), { code: 'AGENT_ERROR' })
    assert.ok(Date.now() - started >= 29_000)
    const [pid] = await agentPids(h)
    await until(() => !isAlive(pid), 5000, 'agent exit')
    assert.equal(await exists(join(h.home, 'sessions')), false)
  }))

  test('U58 a failing session/load releases the lock', () => withHarness({}, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await h.setScript('agent', { errors: { load: true } })
    await assert.rejects(open(h, { session }), { code: 'AGENT_ERROR' })
    const pids = await agentPids(h)
    await until(() => !isAlive(pids[1]), 5000, 'agent exit')
    assert.equal(await exists(lockFile(h, session)), false)
    assert.equal((await h.manager.list())[0].state, 'CLOSED')
  }))
})

describe('reuse', () => {
  test('U34 reuse picks an idle session with the same cwd and subagent', () => withHarness({}, async h => {
    const first = await open(h)
    const second = await open(h, { reuse: true })
    assert.equal(second.session, first.session)
    assert.equal(second.reused, true)
  }))

  test('U35 reuse ignores CLOSED sessions on disk', () => withHarness({}, async h => {
    const first = await open(h)
    await h.manager.close(first.session)
    const before = await readFile(join(sessionDir(h, first.session), 'session.json'), 'utf-8')
    const second = await open(h, { reuse: true })
    assert.notEqual(second.session, first.session)
    assert.equal(second.reused, false)
    assert.equal(await readFile(join(sessionDir(h, first.session), 'session.json'), 'utf-8'), before)
  }))

  test('U36 reuse without a candidate creates a session', () => withHarness({}, async h => {
    const r = await open(h, { reuse: true })
    assert.equal(r.reused, false)
    assert.ok(r.session)
  }))
})

describe('locks across processes', () => {
  test('U37 a session held by a live process is SESSION_IN_USE', () => withHarness({}, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await writeFile(lockFile(h, session), String(process.ppid))
    await assert.rejects(open(h, { session }), { code: 'SESSION_IN_USE' })
  }))

  test('U38 a lock from a dead process is taken over', () => withHarness({}, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await writeFile(lockFile(h, session), String(deadPid()))
    await open(h, { session })
    assert.equal(await readFile(lockFile(h, session), 'utf-8'), String(process.pid))
  }))

  test('U57 close keeps a lock rewritten by another process', () => withHarness({}, async h => {
    const { session } = await open(h)
    await writeFile(lockFile(h, session), String(process.ppid))
    await h.manager.close(session)
    assert.equal(await readFile(lockFile(h, session), 'utf-8'), String(process.ppid))
  }))

  test('U41 another server cannot open or delete our session', { timeout: 30_000 }, () => withHarness({}, async h => {
    const { session } = await open(h)
    const other = await spawnServer(h.home)
    try {
      const opened = await other.call('open', { subagent: 'agent', cwd: h.dir, session })
      const deleted = await other.call('delete', { session })
      assert.equal(opened.data.code, 'SESSION_IN_USE')
      assert.equal(deleted.data.code, 'SESSION_IN_USE')
      assert.equal(h.manager.status(session).state, 'IDLE')
      assert.ok(await exists(join(sessionDir(h, session), 'session.json')))
    } finally {
      await other.close()
    }
  }))

  test('U42 another server does not reuse our session', { timeout: 30_000 }, () => withHarness({}, async h => {
    const { session } = await open(h)
    const other = await spawnServer(h.home)
    try {
      const reply = await other.call('open', { subagent: 'agent', cwd: h.dir, reuse: true })
      assert.equal(reply.isError, false)
      assert.notEqual(reply.data.session, session)
      assert.equal(reply.data.reused, false)
    } finally {
      await other.close()
    }
  }))

  test('U55 two servers reconnecting at once: one wins', { timeout: 30_000 }, () => withHarness({}, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    const [a, b] = await Promise.all([spawnServer(h.home), spawnServer(h.home)])
    try {
      const replies = await Promise.all([a, b].map(s => s.call('open', { subagent: 'agent', cwd: h.dir, session })))
      const winners = replies.map((r, i) => (r.isError ? -1 : i)).filter(i => i >= 0)
      assert.equal(winners.length, 1)
      assert.equal(replies[1 - winners[0]].data.code, 'SESSION_IN_USE')
      assert.equal(await readFile(lockFile(h, session), 'utf-8'), String([a, b][winners[0]].transport.pid))
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  }))
})

describe('idle and listing', () => {
  test('U39 idle sessions are closed after the timeout', () => withHarness({ idle: { timeout: 1 } }, async h => {
    const { session } = await open(h)
    await until(async () => (await h.manager.list())[0].state === 'CLOSED', 4000, 'idle close')
    assert.ok(await exists(join(sessionDir(h, session), 'session.json')))
  }))

  test('U198 idle timeout 0 never closes a session', () => withHarness({ idle: { timeout: 0 } }, async h => {
    await open(h)
    await sleep(2500)
    assert.equal((await h.manager.list())[0].state, 'IDLE')
  }))

  test('U53 sessions shows the first 100 chars of the latest prompt', () => withHarness({}, async h => {
    const { session } = await open(h)
    const long = 'x'.repeat(150)
    await h.manager.prompt(session, 'short', true)
    await h.manager.prompt(session, long, true)
    const [row] = await h.manager.list()
    assert.equal(row.last_prompt, 'x'.repeat(100))
  }))

  test('U83 session.json stays parseable and last_at moves', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 300 }], [{ sleep: 300 }]] } } }, async h => {
    const { session } = await open(h)
    const path = join(sessionDir(h, session), 'session.json')
    const stamps: string[] = []
    const reader = (async () => {
      for (let i = 0; i < 60; i++) {
        stamps.push(JSON.parse(await readFile(path, 'utf-8')).last_at)
        await sleep(10)
      }
    })()
    await h.manager.prompt(session, 'one', true)
    await sleep(20)
    await h.manager.prompt(session, 'two', true)
    await reader
    assert.ok(new Set(stamps).size >= 2)
  }))
})

describe('snapshot', () => {
  test('U32 since returns only newer events', () => withHarness({ scripts: { agent: { turns: [[{ chunk: 'a' }], [{ chunk: 'b' }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'one', true)
    const first = h.manager.snapshot({})
    await h.manager.prompt(session, 'two', true)
    const next = h.manager.snapshot({ since: first.seq, server_id: first.server_id })
    assert.equal(next.reset, false)
    assert.deepEqual(next.sessions[0].events.filter(e => e.type === 'message').map(e => e.text), ['b'])
  }))

  test('U33 snapshot shows a blocking call as waiting', () => withHarness({ scripts: { agent: { turns: [[{ sleep: 1000 }]] } } }, async h => {
    const { session } = await open(h)
    const pending = h.manager.prompt(session, 'go', true)
    await sleep(200)
    assert.equal(h.manager.snapshot({}).sessions[0].waiting, true)
    await pending
    assert.equal(h.manager.snapshot({}).sessions[0].waiting, false)
  }))

  test('U64 a blocking result leaves no notification', () => withHarness({}, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', true)
    const turns = h.manager.snapshot({}).sessions[0].notifications.map(n => n.turn_id)
    assert.ok(!turns.includes(r.turn_id))
  }))

  test('U65 a non-blocking prompt leaves a notification', () => withHarness({}, async h => {
    const { session } = await open(h)
    const r = await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    const turns = h.manager.snapshot({}).sessions[0].notifications.map(n => n.turn_id)
    assert.ok(turns.includes(r.turn_id))
  }))

  test('U66 since older than the buffer resets with the current view', () => withHarness({ scripts: { agent: { turns: [[{ chunks: 600 }]] } } }, async h => {
    const { session } = await open(h)
    const before = h.manager.snapshot({})
    await h.manager.prompt(session, 'go', true)
    const next = h.manager.snapshot({ since: before.seq, server_id: before.server_id })
    assert.equal(next.reset, true)
    assert.match(next.sessions[0].view?.output ?? '', /^c0;c1;.*c599;$/)
  }))

  test('U67 another server_id resets', () => withHarness({}, async h => {
    await open(h)
    const first = h.manager.snapshot({})
    assert.equal(h.manager.snapshot({ since: first.seq, server_id: 'other' }).reset, true)
  }))

  test('U78 a non-blocking approve does not deliver the turn', () => withHarness({ scripts: { agent: { turns: [[{ permission: {} }, { chunk: 'x' }]] } } }, async h => {
    const { session } = await open(h)
    const sent = await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).state === 'ASKING', 5000, 'ASKING')
    const [approval] = h.manager.status(session).approvals
    const started = Date.now()
    await h.manager.respond('approve', session, approval.approval_id, undefined, false)
    assert.ok(Date.now() - started < 500)
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    assert.ok(h.manager.snapshot({}).sessions[0].notifications.some(n => n.turn_id === sent.turn_id))
  }))

  test('U79 ack removes the notification', () => withHarness({}, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    const [notice] = h.manager.snapshot({}).sessions[0].notifications
    assert.ok(notice)
    h.manager.snapshot({ ack: [notice.key] })
    assert.equal(h.manager.snapshot({}).sessions[0].notifications.length, 0)
  }))

  test('U80 notification ids never repeat across sessions and reconnects', () => withHarness({}, async h => {
    const a = await open(h)
    const b = await open(h)
    const finish = async (session: string) => {
      await h.manager.prompt(session, 'go', false)
      await until(() => h.manager.status(session).state === 'IDLE', 5000, 'IDLE')
    }
    await finish(a.session)
    await finish(b.session)
    const keys = h.manager.snapshot({}).sessions.flatMap(s => s.notifications.map(n => [n.key, n.turn_id]))
    await h.manager.close(a.session)
    await open(h, { session: a.session })
    await finish(a.session)
    const after = h.manager.snapshot({}).sessions.find(s => s.session === a.session)?.notifications.map(n => [n.key, n.turn_id]) ?? []
    const all = [...keys, ...after]
    assert.equal(all.length, 3)
    assert.equal(new Set(all.map(([k]) => k)).size, 3)
    assert.equal(new Set(all.map(([, t]) => t)).size, 3)
  }))

  test('U82 replayed events are marked and produce no output or notification', () => withHarness({ scripts: { agent: { replay: ['h1', 'h2', 'h3'] } } }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await open(h, { session })
    const snap = h.manager.snapshot({}).sessions[0]
    const replayed = snap.events.filter(e => e.replay)
    assert.deepEqual(replayed.map(e => e.text), ['h1', 'h2', 'h3'])
    assert.equal(h.manager.output(session).output, '')
    assert.equal(snap.notifications.length, 0)
  }))

  test('U97 with two approvals only the returned one is delivered', () => withHarness({ scripts: { agent: { turns: [[{ permissions: ['A', 'B'] }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).approvals.length === 2, 5000, 'two approvals')
    const r = await h.manager.prompt(session, 'again', true)
    assert.equal(r.approval?.title, 'A')
    const approvals = h.manager.snapshot({}).sessions[0].notifications.map(n => n.approval?.title)
    assert.deepEqual(approvals, ['B'])
  }))
})

describe('close', () => {
  test('U77 closing all ends running and asking sessions', () => withHarness({
    scripts: { run: { turns: [[{ sleep: 10_000 }]] }, ask: { turns: [[{ permission: {} }]] } },
  }, async h => {
    const run = await h.manager.open({ subagent: 'run', cwd: h.dir })
    const ask = await h.manager.open({ subagent: 'ask', cwd: h.dir })
    await h.manager.prompt(run.session, 'go', false)
    await h.manager.prompt(ask.session, 'go', true)
    const result = await h.manager.close()
    assert.deepEqual(result.closed.sort(), [run.session, ask.session].sort())
    assert.ok((await h.events('wire')).some(e => e.outcome === 'cancelled'))
    const pids = await agentPids(h)
    await until(() => pids.every(p => !isAlive(p)), 5000, 'agents exit')
    assert.equal(await exists(lockFile(h, run.session)), false)
    assert.equal(await exists(lockFile(h, ask.session)), false)
    assert.ok((await h.manager.list()).every(r => r.state === 'CLOSED'))
  }))
})

describe('delete', () => {
  const deletable = { scripts: { agent: { delete: true } } }

  test('U74 delete an open session', () => withHarness(deletable, async h => {
    const { session } = await open(h)
    const r = await h.manager.delete(session)
    assert.deepEqual(r, { session, native: 'deleted' })
    assert.equal((await h.events('delete')).length, 1)
    assert.equal(await exists(join(sessionDir(h, session), 'session.json')), false)
    assert.throws(() => h.manager.status(session), { code: 'SESSION_NOT_FOUND' })
  }))

  test('U137 claude deletes an open session through a temporary agent after closing it', () => withHarness({ ...deletable, adapter: 'claude' }, async h => {
    const { session } = await open(h)
    const [livePid] = await agentPids(h)
    const r = await h.manager.delete(session)
    assert.deepEqual(r, { session, native: 'deleted' })
    const pids = await agentPids(h)
    const deletes = await h.events('delete')
    assert.equal(pids.length, 2)
    assert.deepEqual(deletes.map(e => Number(e.pid)), [pids[1]])
    assert.notEqual(pids[1], livePid)
    await until(() => pids.every(p => !isAlive(p)), 5000, 'both agents exit')
    assert.equal(await exists(sessionDir(h, session)), false)
  }))

  test('U75 deleting twice is SESSION_NOT_FOUND', () => withHarness(deletable, async h => {
    const { session } = await open(h)
    await h.manager.delete(session)
    await assert.rejects(h.manager.delete(session), { code: 'SESSION_NOT_FOUND' })
  }))

  test('U76 delete of a session held elsewhere is SESSION_IN_USE', () => withHarness(deletable, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await writeFile(lockFile(h, session), String(process.ppid))
    await assert.rejects(h.manager.delete(session), { code: 'SESSION_IN_USE' })
    assert.ok(await exists(join(sessionDir(h, session), 'session.json')))
  }))

  test('U81 closed session, agent without delete: unsupported', () => withHarness({}, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    const r = await h.manager.delete(session)
    assert.equal(r.native, 'unsupported')
    const pids = await agentPids(h)
    await until(() => pids.every(p => !isAlive(p)), 5000, 'temp agent exit')
    assert.equal(await exists(join(sessionDir(h, session), 'session.json')), false)
  }))

  test('U145 grok deletes open and closed sessions through its own method', () => withHarness({ adapter: 'grok' }, async h => {
    const live = (await open(h)).session
    const closed = (await open(h)).session
    await h.manager.close(closed)
    const [livePid, closedPid] = await agentPids(h)
    assert.deepEqual(await h.manager.delete(live), { session: live, native: 'deleted' })
    assert.deepEqual(await h.manager.delete(closed), { session: closed, native: 'deleted' })
    const pids = await agentPids(h)
    assert.equal(pids.length, 3)
    const deletes = await h.events('delete')
    assert.deepEqual(deletes.map(e => [Number(e.pid), e.sessionId, e.method]), [
      [livePid, live.replace(/^grok_/, ''), '_x.ai/session/delete'],
      [pids[2], closed.replace(/^grok_/, ''), '_x.ai/session/delete'],
    ])
    assert.notEqual(pids[2], closedPid)
    await until(() => pids.every(p => !isAlive(p)), 5000, 'grok agents exit')
    assert.equal(await exists(sessionDir(h, live)), false)
    assert.equal(await exists(sessionDir(h, closed)), false)
  }))

  test('U147 grok answering success false fails the delete and keeps the directory', () => withHarness({ adapter: 'grok', scripts: { agent: { errors: { delete: true } } } }, async h => {
    const { session } = await open(h)
    await assert.rejects(h.manager.delete(session), { code: 'AGENT_ERROR' })
    assert.ok(await exists(join(sessionDir(h, session), 'session.json')))
  }))

  test('U156 opencode deletes open and closed sessions with the standard session/delete', () => withHarness({ adapter: 'opencode', scripts: { agent: { delete: true } } }, async h => {
    const live = (await open(h)).session
    const closed = (await open(h)).session
    await h.manager.close(closed)
    const [livePid, closedPid] = await agentPids(h)
    assert.deepEqual(await h.manager.delete(live), { session: live, native: 'deleted' })
    assert.deepEqual(await h.manager.delete(closed), { session: closed, native: 'deleted' })
    const pids = await agentPids(h)
    assert.equal(pids.length, 3)
    const deletes = await h.events('delete')
    assert.deepEqual(deletes.map(e => [Number(e.pid), e.sessionId, e.method ?? null]), [
      [livePid, live.replace(/^opencode_/, ''), null],
      [pids[2], closed.replace(/^opencode_/, ''), null],
    ])
    assert.notEqual(pids[2], closedPid)
    await until(() => pids.every(p => !isAlive(p)), 5000, 'opencode agents exit')
    assert.equal(await exists(sessionDir(h, live)), false)
    assert.equal(await exists(sessionDir(h, closed)), false)
  }))

  test('U194 antigravity: no native delete for open or closed sessions, directories go anyway', () => withHarness({ adapter: 'antigravity' }, async h => {
    const live = (await open(h)).session
    const closed = (await open(h)).session
    await h.manager.close(closed)
    assert.deepEqual(await h.manager.delete(live), { session: live, native: 'unsupported' })
    assert.deepEqual(await h.manager.delete(closed), { session: closed, native: 'unsupported' })
    assert.equal(await exists(sessionDir(h, live)), false)
    assert.equal(await exists(sessionDir(h, closed)), false)
    const runs = await h.events('argv')
    const pids = runs.flatMap(e => [Number(e.pid), Number(e.ppid)])
    await until(() => pids.every(p => !isAlive(p)), 5000, 'bridges and fake agy exit')
  }))

  test('U84 closed session with delete support: native delete through a temporary agent', () => withHarness(deletable, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    const r = await h.manager.delete(session)
    assert.equal(r.native, 'deleted')
    const deletes = await h.events('delete')
    assert.equal(deletes.length, 1)
    await until(() => !isAlive(deletes[0].pid), 5000, 'temp agent exit')
    assert.equal(await exists(join(sessionDir(h, session), 'session.json')), false)
  }))

  test('U85 delete while ASKING cancels first, then deletes on the same connection', () => withHarness({ scripts: { agent: { delete: true, turns: [[{ permission: {} }, { sleep: 5000 }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', true)
    await h.manager.delete(session)
    const log = await h.log()
    const order = (await h.events('wire'))
      .map(e => (e.outcome === 'cancelled' ? 'cancelled' : e.method))
      .filter(m => m === 'cancelled' || m === 'session/cancel' || m === 'session/delete')
    assert.deepEqual(order, ['cancelled', 'session/cancel', 'session/delete'])
    assert.equal(new Set(log.map(e => e.pid)).size, 1)
    const [pid] = await agentPids(h)
    await until(() => !isAlive(pid), 5000, 'agent exit')
    assert.equal(await exists(sessionDir(h, session)), false)
  }))

  test('U86 failed native delete of a closed session keeps the directory', () => withHarness({ scripts: { agent: { delete: true, errors: { delete: true } } } }, async h => {
    const { session } = await open(h)
    await h.manager.close(session)
    await assert.rejects(h.manager.delete(session), { code: 'AGENT_ERROR' })
    assert.ok(await exists(join(sessionDir(h, session), 'session.json')))
    assert.equal(await exists(lockFile(h, session)), false)
    const pids = await agentPids(h)
    await until(() => pids.every(p => !isAlive(p)), 5000, 'temp agent exit')
  }))

  test('U87 reconnect from another server during delete is SESSION_IN_USE', { timeout: 30_000 }, () => withHarness({ scripts: { agent: { delete: true, delays: { delete: 2000 } } } }, async h => {
    const { session } = await open(h)
    const other = await spawnServer(h.home)
    try {
      const deleting = h.manager.delete(session)
      await sleep(500)
      const reply = await other.call('open', { subagent: 'agent', cwd: h.dir, session })
      assert.equal(reply.data.code, 'SESSION_IN_USE')
      await deleting
      assert.equal(await exists(sessionDir(h, session)), false)
    } finally {
      await other.close()
    }
  }))

  test('U88/U89 cancel not confirmed in 10s fails the delete, a retry succeeds', { timeout: 40_000 }, () => withHarness({ scripts: { agent: { delete: true, delays: { cancel: 'never' }, turns: [[{ sleep: 60_000 }]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    const started = Date.now()
    await assert.rejects(h.manager.delete(session), { code: 'AGENT_ERROR' })
    assert.ok(Date.now() - started >= 9500)
    assert.equal((await h.events('delete')).length, 0)
    const [pid] = await agentPids(h)
    await until(() => !isAlive(pid), 5000, 'agent exit')
    assert.ok(await exists(join(sessionDir(h, session), 'session.json')))
    assert.equal(await exists(lockFile(h, session)), false)
    assert.equal((await h.manager.list())[0].state, 'CLOSED')

    await h.setScript('agent', { delete: true })
    await h.manager.delete(session)
    assert.equal((await h.events('delete')).length, 1)
    assert.equal(await exists(sessionDir(h, session)), false)
  }))

  test('U98/U99 failed native delete of an open session closes it, a retry succeeds', () => withHarness({ scripts: { agent: { delete: true, errors: { delete: true } } } }, async h => {
    const { session } = await open(h)
    await assert.rejects(h.manager.delete(session), { code: 'AGENT_ERROR' })
    const [pid] = await agentPids(h)
    await until(() => !isAlive(pid), 5000, 'agent exit')
    assert.equal((await h.manager.list())[0].state, 'CLOSED')
    assert.ok(await exists(join(sessionDir(h, session), 'session.json')))
    assert.equal(await exists(lockFile(h, session)), false)

    await h.setScript('agent', { delete: true })
    await h.manager.delete(session)
    const deletes = await h.events('delete')
    assert.equal(deletes.length, 2)
    assert.notEqual(deletes[1].pid, pid)
    assert.equal(await exists(sessionDir(h, session)), false)
  }))
})

const savedRecord = async (h: Harness, id: string) => JSON.parse(await readFile(join(sessionDir(h, id), 'session.json'), 'utf-8'))
const titleUpdate = (title: string | null): Step => ({ update: { sessionUpdate: 'session_info_update', title } })
const questionNotices = (h: Harness) => h.manager.snapshot({}).sessions[0].notifications.filter(n => n.type === 'question')

describe('question notifications', () => {
  const questioning = { scripts: { agent: { turns: [[{ question: { message: 'Q' } }, { chunk: 'after' }]] } } }

  test('U169 a non-blocking prompt leaves a question notification until a blocking call returns it', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).state === 'QUESTIONING', 5000, 'QUESTIONING')
    const [notice] = questionNotices(h)
    assert.equal(notice.question?.message, 'Q')
    const r = await h.manager.prompt(session, 'again', true)
    assert.equal(r.question?.question_id, notice.question?.question_id)
    assert.equal(questionNotices(h).length, 0)
  }))

  test('U177 snapshot ack takes question keys; other server ids are ignored', () => withHarness(questioning, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'go', false)
    await until(() => h.manager.status(session).state === 'QUESTIONING', 5000, 'QUESTIONING')
    const [notice] = questionNotices(h)
    assert.match(notice.key, /:question:qu_\d+$/)
    h.manager.snapshot({ ack: [notice.key.replace(h.manager.serverId, 'other')] })
    assert.equal(questionNotices(h).length, 1)
    h.manager.snapshot({ ack: [notice.key] })
    assert.equal(questionNotices(h).length, 0)
    h.manager.snapshot({ ack: [notice.key] })
    const done = await h.manager.answer(session, notice.question?.question_id ?? '', 'accept', { q0: 'red' }, true)
    assert.equal(done.status, 'done')
  }))
})

describe('session titles', () => {
  test('U173 a title is kept, persisted and cleared; updates without title change nothing', () => withHarness({
    scripts: { agent: { turns: [[titleUpdate('T1')], [{ update: { sessionUpdate: 'session_info_update', _meta: { x: 1 } } }], [titleUpdate(null)]] } },
  }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'one', true)
    assert.equal(h.manager.progress(session).title, 'T1')
    await until(async () => (await h.manager.list())[0].title === 'T1', 5000, 'title listed')
    assert.equal((await savedRecord(h, session)).title, 'T1')
    await h.manager.prompt(session, 'two', true)
    assert.equal(h.manager.progress(session).title, 'T1')
    await h.manager.prompt(session, 'three', true)
    assert.equal(h.manager.progress(session).title, null)
    await until(async () => (await h.manager.list())[0].title === '', 5000, 'title cleared')
    assert.equal((await savedRecord(h, session)).title, '')
    assert.equal(h.manager.snapshot({}).sessions[0].events.filter(e => e.type === 'session_info').length, 2)
  }))

  test('U178 a title sent while opening is persisted once the session is registered', () => withHarness({ scripts: { agent: { setup: [titleUpdate('Setup title')] } } }, async h => {
    const { session } = await open(h)
    assert.equal(h.manager.progress(session).title, 'Setup title')
    await until(async () => (await h.manager.list())[0].title === 'Setup title', 5000, 'title listed')
    assert.equal((await savedRecord(h, session)).title, 'Setup title')

    await h.manager.close(session)
    await h.setScript('agent', { setup: [titleUpdate('New title')] })
    await open(h, { session })
    assert.equal(h.manager.progress(session).title, 'New title')
    await until(async () => (await h.manager.list())[0].title === 'New title', 5000, 'new title listed')
    assert.equal((await savedRecord(h, session)).title, 'New title')
  }))

  test('U179 title writes and prompt writes keep each other\'s fields', () => withHarness({
    scripts: { agent: { turns: [1, 2, 3].map(n => [titleUpdate(`T${n}a`), titleUpdate(`T${n}b`), titleUpdate(`T${n}c`), { chunk: 'x' }]) } },
  }, async h => {
    const logs: string[] = []
    h.host.log = message => { logs.push(message) }
    const { session } = await open(h)
    await ['p1', 'p2', 'p3'].reduce(async (prev, text) => {
      await prev
      assert.equal((await h.manager.prompt(session, text, true)).status, 'done')
    }, Promise.resolve())
    await until(async () => (await savedRecord(h, session)).title === 'T3c', 5000, 'last title saved')
    assert.equal((await savedRecord(h, session)).last_prompt, 'p3')
    assert.ok(!logs.some(l => /save title/.test(l)), logs.join('\n'))
  }))

  test('U181 a clear as the first title after a reconnect reaches session.json', () => withHarness({ scripts: { agent: { turns: [[titleUpdate('Old')]] } } }, async h => {
    const { session } = await open(h)
    await h.manager.prompt(session, 'one', true)
    await until(async () => (await savedRecord(h, session)).title === 'Old', 5000, 'old title saved')
    await h.manager.close(session)
    await h.setScript('agent', { turns: [[titleUpdate(null)], [titleUpdate(null)]] })
    await open(h, { session })
    await h.manager.prompt(session, 'two', true)
    assert.equal(h.manager.progress(session).title, null)
    await until(async () => (await savedRecord(h, session)).title === '', 5000, 'title cleared')
    assert.equal((await h.manager.list())[0].title, '')
    await h.manager.prompt(session, 'three', true)
    assert.equal(h.manager.snapshot({}).sessions[0].events.filter(e => e.type === 'session_info').length, 1)
  }))

  // Each write takes 1s: the prompt's last_prompt write ends near 1s and the title write near 2s.
  // The exit at 1.5s lands while the title write is still pending.
  for (const [label, turn] of [
    ['close', [titleUpdate('T'), { sleep: 3000 }]],
    ['an unexpected exit', [titleUpdate('T'), { sleep: 1500 }, { exit: 1 }]],
  ] satisfies Array<[string, Step[]]>) {
    test(`U183 ${label} keeps lock.pid until a pending title write is done`, { timeout: 30_000 }, () => withHarness({ scripts: { agent: { turns: [turn] } } }, async h => {
      const host = new SlowWriteHost(1000)
      const logs: string[] = []
      host.log = message => { logs.push(message) }
      const manager = new SessionManager(host, h.config, h.home)
      try {
        const { session } = await manager.open({ subagent: 'agent', cwd: h.dir })
        await manager.prompt(session, 'go', false)
        await until(() => manager.progress(session).title === 'T', 5000, 'title received')
        label === 'close' && await manager.close(session)
        await until(async () => !await exists(lockFile(h, session)), 10_000, 'lock released')
        const saved = host.ops.lastIndexOf(`rename:${join(sessionDir(h, session), 'session.json')}`)
        const released = host.ops.indexOf(`remove:${lockFile(h, session)}`)
        assert.ok(saved >= 0 && saved < released, host.ops.join('\n'))
        assert.equal((await savedRecord(h, session)).title, 'T')
        assert.ok(!logs.some(l => /failed/.test(l)), logs.join('\n'))
      } finally {
        await manager.shutdown()
      }
    }))
  }
})

describe('activity', () => {
  const closed = (seen: SessionActivity[]) => seen.flatMap(({ session, activity }) => (activity.kind === 'session_closed' ? [[session, activity.reason]] : []))

  test('U204 each way a session ends is reported once with its reason', async () => {
    await withHarness({ scripts: { agent: { delete: true } } }, async h => {
      const seen = recordActivity(h.manager)
      const a = (await open(h)).session
      const b = (await open(h)).session
      const c = (await open(h)).session
      const d = (await open(h)).session
      await h.manager.close(a)
      // Opened one after another, so the second agent started is b's
      const [, pidOfB] = await agentPids(h)
      process.kill(pidOfB, 'SIGKILL')
      await until(() => closed(seen).some(([s]) => s === b), 5000, 'exited')
      await h.manager.delete(c)
      await h.manager.shutdown()
      assert.deepEqual(closed(seen), [[a, 'closed'], [b, 'exited'], [c, 'deleted'], [d, 'shutdown']])
    })
    await withHarness({ idle: { timeout: 1 } }, async h => {
      const seen = recordActivity(h.manager)
      const { session } = await open(h)
      await until(() => closed(seen).length > 0, 4000, 'idle close')
      assert.deepEqual(closed(seen), [[session, 'idle']])
    })
  })

  test('U205 a temporary agent reports nothing; an unsubscribed listener hears nothing more', () => withHarness({ scripts: { agent: { delete: true } } }, async h => {
    const seen = recordActivity(h.manager)
    const { session } = await open(h)
    await h.manager.close(session)
    const before = seen.length
    assert.deepEqual(await h.manager.delete(session), { session, native: 'deleted' })
    assert.equal(seen.length, before)
    const late: SessionActivity[] = []
    const unsubscribe = h.manager.onActivity(activity => late.push(activity))
    unsubscribe()
    const reopened = await open(h)
    await h.manager.prompt(reopened.session, 'go', true)
    assert.deepEqual(late, [])
    assert.ok(seen.length > before)
  }))
})
