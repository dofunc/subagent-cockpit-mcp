// Host interface. The session and adapter layers reach the outside world only through it,
// so they stay free of Node APIs and can run inside another host later.

export interface SpawnOptions {
  cwd?: string
  env: Record<string, string>
}

export interface ExitInfo {
  code: number | null
  signal: string | null
}

export interface ChildProcess {
  readonly pid: number | undefined
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  /** Settles once the process has exited, including spawn failures (code null). */
  readonly exited: Promise<ExitInfo>
  /** Close stdin after the data already written, so the agent can exit on EOF. */
  end(): void
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}

export interface Timer {
  cancel(): void
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): Timer
  setInterval(fn: () => void, ms: number): Timer
}

export interface Store {
  join(...parts: string[]): string
  readText(path: string): Promise<string>
  writeText(path: string, data: string): Promise<void>
  /** Create a file only when it does not exist yet. Returns false when it already exists. */
  createExclusive(path: string, data: string): Promise<boolean>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  /** Remove a file or a directory tree. Missing targets are ignored. */
  remove(path: string): Promise<void>
  list(dir: string): Promise<string[]>
  exists(path: string): Promise<boolean>
}

export interface Env {
  readonly pid: number
  get(name: string): string | undefined
  all(): Record<string, string>
  isAlive(pid: number): boolean
  homeDir(): string
  execPath(): string
}

export interface Host {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess
  readonly clock: Clock
  readonly store: Store
  readonly env: Env
  /** Absolute path of a file shipped next to dist/cli.js. */
  bundledPath(file: string): string
  /**
   * Absolute path of an executable, or undefined when missing or not executable. `command` with a
   * path separator is a path (relative to this process's cwd); otherwise a name looked up in pathList.
   */
  findExecutable(command: string, pathList: string): Promise<string | undefined>
  /** Diagnostics go to stderr; stdout belongs to the MCP protocol. */
  log(message: string): void
}
