import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const DIST_CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'cockpit-cli-'))
  try {
    await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

function run(args: string[], home: string) {
  return spawnSync(process.execPath, [DIST_CLI, ...args], {
    env: { ...process.env, SUBAGENT_COCKPIT_HOME: home, SUBAGENT_COCKPIT_WEBUI_PORT: '0' },
    input: '',
    encoding: 'utf-8',
    timeout: 10_000,
  })
}

describe('command line', () => {
  for (const args of [[], ['mcp'], ['mcp', '--transport', 'stdio']]) {
    test(`U90 "${args.join(' ')}" starts the MCP server`, () => withHome(async home => {
      const client = new Client({ name: 'test', version: '1' })
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, ...args], env: { PATH: process.env.PATH ?? '', SUBAGENT_COCKPIT_HOME: home, SUBAGENT_COCKPIT_WEBUI_PORT: '0' }, stderr: 'pipe' }))
        assert.equal((await client.listTools()).tools.length, 17)
      } finally {
        await client.close()
      }
    }))
  }

  test('U91 --transport http is rejected', () => withHome(async home => {
    const r = run(['mcp', '--transport', 'http'], home)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /stdio/)
    assert.equal(r.stdout, '')
  }))

  for (const args of [['daemon', 'start'], ['open'], ['foo'], ['mcp', 'extra'], ['mcp', '--unknown'], ['mcp', '--port', '7200'], ['--home', '/tmp/x']]) {
    test(`U92 "${args.join(' ')}" fails without starting the server`, () => withHome(async home => {
      const r = run(args, home)
      assert.notEqual(r.status, 0)
      assert.equal(r.stdout, '')
    }))
  }

  test('U93 --version prints the package version', () => withHome(async home => {
    const { version } = JSON.parse(await readFile(PACKAGE_JSON, 'utf-8'))
    const r = run(['--version'], home)
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim(), version)
  }))

  test('U94 stdout carries only JSON-RPC messages', () => withHome(async home => {
    const child = spawn(process.execPath, [DIST_CLI], { env: { ...process.env, SUBAGENT_COCKPIT_HOME: home, SUBAGENT_COCKPIT_WEBUI_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = { stdout: '', stderr: '' }
    child.stdout.on('data', (c: Buffer) => { out.stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { out.stderr += c.toString() })
    const exited = new Promise(resolve => child.once('exit', resolve))
    const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'subagents', arguments: {} } })
    await new Promise(resolve => setTimeout(resolve, 1500))
    child.stdin.end()
    await exited
    const lines = out.stdout.trim().split('\n')
    assert.equal(lines.length, 2)
    lines.forEach(line => assert.equal(JSON.parse(line).jsonrpc, '2.0'))
    assert.match(out.stderr, /Created default config/)
  }))
})

const MODULE_ERROR = /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/

/** Run a bundled file from a copy of dist/ for `ms`, optionally sending one ndjson message. */
function runBundled(dir: string, file: string, env: Record<string, string>, message: object | null, ms: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(dir, file)], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, ...env } })
    const out = { stdout: '', stderr: '' }
    child.stdout.on('data', (c: Buffer) => { out.stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { out.stderr += c.toString() })
    message && child.stdin.write(`${JSON.stringify(message)}\n`)
    setTimeout(() => {
      child.kill('SIGKILL')
      resolve(out)
    }, ms)
  })
}

describe('standalone package', () => {
  test('U117 bundled ACP adapters run without node_modules', () => withHome(async root => {
    const dist = join(root, 'dist')
    await cp(fileURLToPath(new URL('../dist', import.meta.url)), dist, { recursive: true })
    const fake = join(root, 'fake-claude')
    await writeFile(fake, '#!/bin/sh\necho "2.1.292 (Claude Code)"\n')
    await chmod(fake, 0o755)
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }
    const [claude, codex, agy, pi] = await Promise.all([
      runBundled(dist, 'claude-agent-acp.js', { CLAUDE_CODE_EXECUTABLE: fake }, initialize, 4000),
      runBundled(dist, 'codex-acp.js', { CODEX_PATH: join(root, 'no-such-codex') }, null, 2000),
      runBundled(dist, 'agy-acp.js', { AGY_PATH: join(root, 'no-such-agy') }, initialize, 2000),
      runBundled(dist, 'pi-acp.js', { PI_PATH: join(root, 'no-such-pi') }, initialize, 2000),
    ])
    const replyOf = (stdout: string) => stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === 1)
    assert.equal(replyOf(claude.stdout)?.result?.agentCapabilities?.loadSession, true)
    const agyCapabilities = replyOf(agy.stdout)?.result?.agentCapabilities
    assert.deepEqual(agyCapabilities?.sessionCapabilities?.resume, {})
    assert.equal(agyCapabilities?.loadSession, undefined)
    const piCapabilities = replyOf(pi.stdout)?.result?.agentCapabilities
    assert.equal(piCapabilities?.loadSession, true)
    assert.deepEqual(piCapabilities?.sessionCapabilities, { resume: {}, delete: {} })
    assert.doesNotMatch(claude.stderr, MODULE_ERROR)
    assert.doesNotMatch(codex.stderr, MODULE_ERROR)
    assert.doesNotMatch(agy.stderr, MODULE_ERROR)
    assert.doesNotMatch(pi.stderr, MODULE_ERROR)
    const source = fileURLToPath(new URL('../node_modules/@agentclientprotocol/codex-acp/dist/index.js', import.meta.url))
    assert.ok((await readFile(join(dist, 'codex-acp.js'))).equals(await readFile(source)))
  }))

  test('U118 the package has no runtime dependencies', async () => {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf-8'))
    assert.equal('dependencies' in pkg, false)
    const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf-8' })
    const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path)
    assert.ok(files.every(f => f.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(f)), files.join(', '))
    assert.equal(files.includes('npm-shrinkwrap.json'), false)
  })
})
