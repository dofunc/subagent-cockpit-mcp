// Fake agy for the bridge tests. `--version` prints 1.4.2, `models` prints the scripted ids, anything else runs
// print mode: answers stdin `user` events per FAKE_AGY_SCRIPT and logs argv, inputs and signals to FAKE_AGY_LOG.
import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

export interface FakeTurn {
  /** Regex the user text must match; the first matching turn answers, else the reply is `ok` */
  match: string
  /** Lines printed to stdout as is before the steps */
  raw?: string[]
  steps?: Array<Record<string, unknown>>
  result?: Record<string, unknown>
  /** Wait for SIGINT instead of finishing; on SIGINT emit result ERROR `interrupted`, then exit 1 after 300ms */
  hang?: boolean
  /** With hang: ignore SIGINT (logged anyway), so only SIGKILL ends the process */
  ignore_sigint?: boolean
  /** Exit with code 3 before the result */
  crash?: boolean
}

export interface FakeAgyScript {
  /** Lines printed by `agy models` (id<TAB>name); exit 1 when null */
  models?: string[] | null
  /** Id of a new conversation (default: a random uuid) */
  conversation_id?: string
  /** Emit result ERROR `authentication failed or timed out` instead of init */
  auth_error?: boolean
  /** Ignore --conversation and start a new id, as agy does for an unknown one */
  unknown_conversation?: boolean
  /** Delay init by this many ms when started with --conversation */
  resume_init_delay_ms?: number
  /** Delay the exit after stdin ends (no turn running) by this many ms */
  stdin_exit_delay_ms?: number
  turns?: FakeTurn[]
}

export const DEFAULT_MODELS = [
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--version') {
    process.stdout.write('1.4.2\n')
    return
  }
  const script: FakeAgyScript = JSON.parse(process.env.FAKE_AGY_SCRIPT ? readFileSync(process.env.FAKE_AGY_SCRIPT, 'utf-8') : '{}')
  const logPath = process.env.FAKE_AGY_LOG
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    logPath && appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, event, ...extra })}\n`)
  }
  if (argv[0] === 'models') {
    log('models')
    if (script.models === null) {
      process.stderr.write('Fetching available models...\nfailed to list models\n')
      process.exit(1)
    }
    process.stdout.write(`${(script.models ?? DEFAULT_MODELS).join('\n')}\n`)
    return
  }
  await printMode(argv, script, log)
}

async function printMode(argv: string[], script: FakeAgyScript, log: (event: string, extra?: Record<string, unknown>) => void): Promise<void> {
  const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`)
  const exit = (code: number) => {
    log('exit', { code })
    process.exit(code)
  }
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const env = Object.fromEntries(['AGY_PATH', 'CODEX_PATH', 'CLAUDE_CODE_EXECUTABLE'].map(k => [k, process.env[k] ?? null]))
  log('argv', { argv, ppid: process.ppid, env })
  const requested = flag('--conversation')
  const conversationId = requested && !script.unknown_conversation ? requested : script.conversation_id ?? randomUUID()
  const state: { running: boolean; hanging?: FakeTurn; stdinEnded: boolean } = { running: false, stdinEnded: false }

  process.on('SIGINT', () => {
    log('sigint')
    const turn = state.hanging
    if (turn?.ignore_sigint) return
    if (!turn) exit(1)
    emit({ event: 'result', result: { conversation_id: conversationId, status: 'ERROR', response: '', error: 'interrupted' } })
    setTimeout(() => exit(1), 300)
  })

  if (script.auth_error) {
    emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out' } })
    exit(1)
  }
  requested && script.resume_init_delay_ms && await sleep(script.resume_init_delay_ms)
  emit({ event: 'init', conversation_id: conversationId, init: { model: flag('--model') ?? 'default', cwd: process.cwd() } })

  const runTurn = async (text: string) => {
    const turn = script.turns?.find(t => new RegExp(t.match).test(text))
    state.running = true
    turn?.raw?.forEach(line => process.stdout.write(`${line}\n`))
    const steps = turn ? turn.steps ?? [] : [{ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ok' }]
    steps.forEach(step => emit({ event: 'step_update', step_update: step }))
    if (turn?.crash) exit(3)
    if (turn?.hang) {
      state.hanging = turn
      // Like a real agy busy on a turn: stay up after stdin ends, until SIGINT (or SIGKILL with ignore_sigint)
      setInterval(() => undefined, 60_000)
      return
    }
    emit({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response: turn ? '' : 'ok', ...turn?.result } })
    state.running = false
    state.stdinEnded && exit(0)
  }

  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    if (!line.trim()) return
    const input = JSON.parse(line)
    const text = (input.message?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('')
    log('input', { kind: input.event, text })
    input.event === 'user' && runTurn(text)
  })
  lines.on('close', async () => {
    state.stdinEnded = true
    if (state.running) return
    script.stdin_exit_delay_ms && await sleep(script.stdin_exit_delay_ms)
    exit(0)
  })
}

main()
