import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeHost } from '../../src/host/node-host'
import { SessionStore } from '../../src/session/session-store'
import type { SessionRecord } from '../../src/session/session-store'
import { SlowWriteHost } from '../fixtures/harness'

async function withStore(fn: (store: SessionStore, home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'cockpit-store-'))
  try {
    await fn(new SessionStore(new NodeHost(), home), home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const record = (extra: Partial<SessionRecord> = {}): SessionRecord => ({
  subagent: 'codex',
  cwd: '/tmp',
  role: 'r',
  created_at: '2026-10-15T00:00:00.000Z',
  last_prompt: '',
  last_at: '',
  ...extra,
})

/** pid of a process that has already exited */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  return pid ?? 999_999
}

const lockPath = (home: string, id: string) => join(home, 'sessions', id, 'lock.pid')

describe('session ids', () => {
  test('id is <adapter>_<native id>', () => {
    assert.equal(SessionStore.sessionId('codex', 'abc-1'), 'codex_abc-1')
    assert.deepEqual(SessionStore.parseId('codex_abc_1'), { adapter: 'codex', native: 'abc_1' })
    assert.equal(SessionStore.parseId('nounderscore'), null)
  })
})

describe('session.json', () => {
  test('update merges and rewrites atomically', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    await store.update('codex_a', { last_prompt: 'hi', last_at: '2026-10-15T01:00:00.000Z' })
    const saved = JSON.parse(await readFile(join(home, 'sessions', 'codex_a', 'session.json'), 'utf-8'))
    assert.equal(saved.last_prompt, 'hi')
    assert.equal(saved.subagent, 'codex')
  }))

  test('U239 config round-trips with its value types; a record without config still reads', () => withStore(async store => {
    await store.create('codex_a', record())
    assert.equal((await store.read('codex_a')).config, undefined)
    await store.update('codex_a', { config: { model: 'gpt-b', fast: true } })
    await store.update('codex_a', { last_prompt: 'hi' })
    const saved = await store.read('codex_a')
    assert.deepEqual(saved.config, { model: 'gpt-b', fast: true })
    assert.equal(saved.last_prompt, 'hi')
  }))

  test('U180 updates of one session run one after another; remove waits for them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-store-'))
    const host = new SlowWriteHost(100)
    const store = new SessionStore(host, home)
    const dir = join(home, 'sessions', 'codex_a')
    try {
      await store.create('codex_a', record())
      const fields: Array<Partial<SessionRecord>> = [{ role: 'r2' }, { cwd: '/w' }, { last_prompt: 'p' }, { last_at: '2026-10-18T00:00:00.000Z' }, { title: 't' }]
      await Promise.all(fields.map(patch => store.update('codex_a', patch)))
      const saved = JSON.parse(await readFile(join(dir, 'session.json'), 'utf-8'))
      assert.deepEqual(saved, { ...record(), ...Object.assign({}, ...fields) })
      assert.deepEqual(await readdir(dir), ['session.json'])

      const pending = store.update('codex_a', { title: 'last' })
      await store.remove('codex_a')
      await pending
      const renamed = host.ops.lastIndexOf(`rename:${join(dir, 'session.json')}`)
      assert.ok(renamed >= 0 && renamed < host.ops.indexOf(`remove:${dir}`), host.ops.join('\n'))
      await assert.rejects(readdir(dir), { code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('list orders by last_at, falling back to created_at', () => withStore(async store => {
    await store.create('codex_old', record({ created_at: '2026-10-01T00:00:00.000Z' }))
    await store.create('codex_new', record({ created_at: '2026-10-02T00:00:00.000Z' }))
    await store.create('codex_active', record({ created_at: '2026-09-01T00:00:00.000Z', last_at: '2026-10-03T00:00:00.000Z' }))
    assert.deepEqual((await store.list()).map(s => s.id), ['codex_active', 'codex_new', 'codex_old'])
  }))
})

describe('lock.pid', () => {
  test('first acquire creates the lock with own pid', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    assert.equal(await store.acquireLock('codex_a'), true)
    assert.equal(await readFile(lockPath(home, 'codex_a'), 'utf-8'), String(process.pid))
  }))

  test('a lock held by a live process blocks', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    await writeFile(lockPath(home, 'codex_a'), String(process.ppid))
    assert.equal(await store.acquireLock('codex_a'), false)
    assert.equal(await store.lockedByOther('codex_a'), true)
  }))

  test('a lock left by a dead process is taken over', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    await writeFile(lockPath(home, 'codex_a'), String(deadPid()))
    assert.equal(await store.acquireLock('codex_a'), true)
    assert.equal(await readFile(lockPath(home, 'codex_a'), 'utf-8'), String(process.pid))
  }))

  test('U148 an empty lock is being created: the pid written next decides', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    await writeFile(lockPath(home, 'codex_a'), '')
    setTimeout(() => { writeFile(lockPath(home, 'codex_a'), String(process.ppid)).catch(() => undefined) }, 30)
    assert.equal(await store.acquireLock('codex_a'), false)
    assert.equal(await readFile(lockPath(home, 'codex_a'), 'utf-8'), String(process.ppid))
  }))

  test('U149 a lock that stays empty is taken over', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    await writeFile(lockPath(home, 'codex_a'), '')
    const started = Date.now()
    assert.equal(await store.acquireLock('codex_a'), true)
    assert.ok(Date.now() - started >= 140, `elapsed ${Date.now() - started}`)
    assert.equal(await readFile(lockPath(home, 'codex_a'), 'utf-8'), String(process.pid))
  }))

  test('release keeps a lock owned by someone else', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    await store.acquireLock('codex_a')
    await writeFile(lockPath(home, 'codex_a'), String(process.ppid))
    await store.releaseLock('codex_a')
    assert.equal(await readFile(lockPath(home, 'codex_a'), 'utf-8'), String(process.ppid))
  }))

  test('release removes own lock', () => withStore(async (store, home) => {
    await store.create('codex_a', record())
    await store.acquireLock('codex_a')
    await store.releaseLock('codex_a')
    await assert.rejects(readFile(lockPath(home, 'codex_a'), 'utf-8'), { code: 'ENOENT' })
  }))
})
