import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ChildProcess, ExitInfo, Host } from './host'

function errorCode(err: Error): string | undefined {
  return 'code' in err && typeof err.code === 'string' ? err.code : undefined
}

/** Host implementation backed by Node built-ins. Only the MCP layer creates it. */
export class NodeHost implements Host {
  readonly clock = {
    now: () => Date.now(),
    setTimeout(fn: () => void, ms: number) {
      const t = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(t) }
    },
    setInterval(fn: () => void, ms: number) {
      const t = setInterval(fn, ms)
      t.unref()
      return { cancel: () => clearInterval(t) }
    },
  }

  readonly store = {
    join: (...parts: string[]) => join(...parts),
    readText: (path: string) => readFile(path, 'utf-8'),
    writeText: (path: string, data: string) => writeFile(path, data),
    async createExclusive(path: string, data: string) {
      try {
        await writeFile(path, data, { flag: 'wx' })
        return true
      } catch (err) {
        if (err instanceof Error && errorCode(err) === 'EEXIST') return false
        throw err
      }
    },
    rename: (from: string, to: string) => rename(from, to),
    mkdir: async (path: string) => { await mkdir(path, { recursive: true }) },
    remove: (path: string) => rm(path, { recursive: true, force: true }),
    list: (dir: string) => readdir(dir),
    exists: (path: string) => stat(path).then(() => true, () => false),
  }

  readonly env = {
    pid: process.pid,
    get: (name: string) => process.env[name],
    all: () => Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
    ),
    isAlive(pid: number) {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        return err instanceof Error && errorCode(err) === 'EPERM'
      }
    },
    homeDir: () => homedir(),
    execPath: () => process.execPath,
  }

  spawn(command: string, args: string[], options: { cwd?: string; env: Record<string, string> }): ChildProcess {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'inherit'] })
    const exited = new Promise<ExitInfo>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', err => {
        this.log(`spawn ${command} failed: ${err.message}`)
        resolve({ code: null, signal: null })
      })
    })
    // A dead peer must not crash the process with EPIPE
    child.stdin.on('error', err => this.log(`agent stdin error: ${err.message}`))
    // Readable.toWeb is typed as ReadableStream<any>, so wrap the byte stream by hand
    const stream = { open: true }
    const finish = (fn: () => void) => {
      if (!stream.open) return
      stream.open = false
      fn()
    }
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on('data', (chunk: Buffer) => stream.open && controller.enqueue(new Uint8Array(chunk)))
        child.stdout.once('end', () => finish(() => controller.close()))
        child.stdout.once('close', () => finish(() => controller.close()))
        child.stdout.once('error', err => finish(() => controller.error(err)))
      },
      cancel() {
        stream.open = false
        child.stdout.destroy()
      },
    })
    return {
      pid: child.pid,
      stdin: Writable.toWeb(child.stdin),
      stdout,
      exited,
      end: () => { child.stdin.end() },
      kill: (signal = 'SIGTERM') => { child.kill(signal) },
    }
  }

  bundledPath(file: string): string {
    return fileURLToPath(new URL(file, import.meta.url))
  }

  async findExecutable(command: string, pathList: string): Promise<string | undefined> {
    const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';')] : ['']
    // Relative paths and PATH entries resolve against this process's cwd, not the session cwd
    const bases = /[\\/]/.test(command)
      ? [resolve(command)]
      : pathList.split(delimiter).filter(Boolean).map(dir => join(resolve(dir), command))
    const candidates = bases.flatMap(base => exts.map(ext => `${base}${ext}`))
    const checks = await Promise.all(candidates.map(c => access(c, constants.X_OK).then(() => true, () => false)))
    return candidates.find((_, i) => checks[i])
  }

  log(message: string): void {
    process.stderr.write(`[subagent-cockpit] ${message}\n`)
  }
}
