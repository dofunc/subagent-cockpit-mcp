// Fake pi for the bridge tests. `--version` prints 1.4.0; `--mode rpc` answers JSONL commands per FAKE_PI_SCRIPT and logs
// argv, commands and signals to FAKE_PI_LOG. Sessions live as <FAKE_PI_DIR>/<id>.jsonl so delete and resume can be checked.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export interface FakePiTurn {
  /** Regex the prompt text must match; the first matching turn answers, else the reply is `ok` */
  match: string
  /** Records written to stdout as they are, in order, after the prompt response (session events) */
  events?: Array<Record<string, unknown>>
  /** Lines written to stdout as they are, before the events (e.g. a non-JSON line) */
  raw?: string[]
  /** Stop reason of the last assistant message: stop (default), length or error */
  stop_reason?: 'stop' | 'length' | 'error'
  error_message?: string
  /** Wait for an abort command instead of settling; then emit agent_settled with aborted: true */
  hang?: boolean
  /** Exit with code 3 before agent_settled */
  crash?: boolean
}

export interface FakePiScript {
  /** Models of get_available_models as provider/id; default ['sub2api/model-a', 'sub2api/model-b'] */
  models?: string[]
  /** Levels of get_available_thinking_levels; default ['off', 'low', 'medium', 'high'] */
  levels?: string[]
  /** prompt fails with `No API key found for the selected model.` */
  no_key?: boolean
  /** Commands of get_commands; default []. description may be left out, as pi allows for extension commands */
  commands?: Array<{ name: string; description?: string }>
  /** Delay the get_messages response by this many ms (to check that the commands follow the load response) */
  messages_delay_ms?: number
  /** contextUsage of get_session_stats: default { tokens: 1200, contextWindow: 272000 }; 'omit' leaves it out, 'null_tokens' sets tokens to null */
  context_usage?: 'omit' | 'null_tokens' | { tokens: number; contextWindow: number }
  /** get_session_stats fails */
  stats_error?: boolean
  /** Delay the first get_state response by this many ms when started with --session (a restart the test can cancel in) */
  resume_delay_ms?: number
  /** One extension_ui_request dialog sent during the first turn; the bridge must answer it */
  dialog?: boolean
  turns?: FakePiTurn[]
}

type Command = { id?: string; type: string; [key: string]: unknown }

interface FakeState {
  model: { provider: string; id: string; name: string }
  thinking: string
  running: boolean
  hanging: boolean
  turns: number
  /** The first get_state of a resumed process waits resume_delay_ms */
  delayedState: boolean
  /** Resolves the pending extension dialog once the bridge answers it */
  dialog?: (cancelled: boolean) => void
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const DEFAULT_MODELS = ['sub2api/model-a', 'sub2api/model-b']
const DEFAULT_LEVELS = ['off', 'low', 'medium', 'high']

function main(): void {
  const argv = process.argv.slice(2)
  if (argv[0] === '--version') {
    process.stdout.write('1.4.0\n')
    return
  }
  const script: FakePiScript = JSON.parse(process.env.FAKE_PI_SCRIPT ? readFileSync(process.env.FAKE_PI_SCRIPT, 'utf-8') : '{}')
  const logPath = process.env.FAKE_PI_LOG
  const dir = process.env.FAKE_PI_DIR ?? join(process.cwd(), '.fake-pi')
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    logPath && appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, event, ...extra })}\n`)
  }
  const exit = (code: number) => {
    log('exit', { code })
    process.exit(code)
  }
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  log('argv', { argv, ppid: process.ppid, cwd: process.cwd(), env: { PI_PATH: process.env.PI_PATH ?? null } })
  mkdirSync(dir, { recursive: true })
  const requested = flag('--session')
  const sessionId = requested ?? randomUUID()
  const sessionFile = join(dir, `${sessionId}.jsonl`)
  if (requested && !existsSync(sessionFile)) {
    process.stderr.write(`No session found matching '${requested}'\n`)
    exit(1)
  }
  requested || writeFileSync(sessionFile, '')

  const models = script.models ?? DEFAULT_MODELS
  const modelOf = (value: string) => {
    const slash = value.indexOf('/')
    return { provider: value.slice(0, slash), id: value.slice(slash + 1), name: `Model ${value.slice(slash + 1)}` }
  }
  const state: FakeState = {
    model: script.no_key ? { provider: 'unknown', id: 'unknown', name: 'unknown' } : modelOf(models[0]),
    // Like pi, the current level is one the model offers
    thinking: (script.levels ?? DEFAULT_LEVELS).includes('medium') ? 'medium' : (script.levels ?? DEFAULT_LEVELS)[0],
    running: false,
    hanging: false,
    turns: 0,
    delayedState: Boolean(requested && script.resume_delay_ms),
  }
  const write = (record: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(record)}\n`)
  const respond = (command: Command, data?: Record<string, unknown>) => write({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) })
  const fail = (command: Command, error: string) => write({ id: command.id, type: 'response', command: command.type, success: false, error })
  const messages = () => readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const record = (message: Record<string, unknown>) => appendFileSync(sessionFile, `${JSON.stringify(message)}\n`)
  const settle = (aborted: boolean) => {
    state.running = false
    state.hanging = false
    write({ type: 'agent_end', messages: [] })
    write({ type: 'agent_settled', aborted })
  }

  const runTurn = async (text: string) => {
    state.running = true
    state.turns += 1
    record({ role: 'user', content: text })
    const turn = script.turns?.find(t => new RegExp(t.match).test(text))
    turn?.raw?.forEach(line => process.stdout.write(`${line}\n`))
    write({ type: 'agent_start' })
    if (script.dialog && state.turns === 1) {
      const answered = new Promise<boolean>(resolve => { state.dialog = resolve })
      write({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Proceed?', message: 'Continue the task?' })
      await answered
    }
    const events = turn?.events ?? [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ok' } }]
    events.forEach(event => write(event))
    if (turn?.crash) exit(3)
    if (turn?.hang) {
      state.hanging = true
      return
    }
    const reply = events.map(e => {
      const update = e.assistantMessageEvent
      return typeof update === 'object' && update !== null && 'type' in update && update.type === 'text_delta' && 'delta' in update ? String(update.delta) : ''
    }).join('')
    const assistant = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: turn?.stop_reason ?? 'stop', ...(turn?.error_message ? { errorMessage: turn.error_message } : {}) }
    record(assistant)
    write({ type: 'turn_end', message: assistant, toolResults: [] })
    settle(false)
  }

  const contextUsage = () => {
    if (script.context_usage === 'omit') return {}
    if (script.context_usage === 'null_tokens') return { contextUsage: { tokens: null, contextWindow: 272000, percent: null } }
    return { contextUsage: script.context_usage ?? { tokens: 1200, contextWindow: 272000 } }
  }

  const handle = async (command: Command) => {
    switch (command.type) {
      case 'get_state':
        if (state.delayedState) {
          state.delayedState = false
          await sleep(script.resume_delay_ms ?? 0)
        }
        return respond(command, { model: state.model, thinkingLevel: state.thinking, isStreaming: state.running, sessionFile, sessionId, messageCount: messages().length })
      case 'get_available_models':
        return respond(command, { models: script.no_key ? [] : models.map(modelOf) })
      case 'get_available_thinking_levels':
        return respond(command, { levels: script.levels ?? DEFAULT_LEVELS })
      case 'set_model': {
        const wanted = `${String(command.provider)}/${String(command.modelId)}`
        if (!models.includes(wanted)) return fail(command, `Model not found: ${wanted}`)
        state.model = modelOf(wanted)
        return respond(command, state.model)
      }
      case 'set_thinking_level':
        state.thinking = String(command.level)
        return respond(command)
      case 'get_commands':
        return respond(command, { commands: script.commands ?? [] })
      case 'get_messages':
        await sleep(script.messages_delay_ms ?? 0)
        return respond(command, { messages: messages() })
      case 'get_session_stats':
        if (script.stats_error) return fail(command, 'stats unavailable')
        return respond(command, { sessionFile, sessionId, cost: 0, ...contextUsage() })
      case 'prompt':
        if (state.running) return fail(command, 'Agent is already processing. Specify streamingBehavior (\'steer\' or \'followUp\') to queue the message.')
        if (script.no_key) return fail(command, 'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.')
        respond(command, { disposition: 'started' })
        return runTurn(String(command.message))
      case 'abort':
        state.hanging && settle(true)
        return respond(command)
      default:
        return fail(command, `Unknown command: ${command.type}`)
    }
  }

  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    if (!line.trim()) return
    const command: Command = JSON.parse(line)
    if (command.type === 'extension_ui_response') {
      log('ui_response', { id: command.id, cancelled: command.cancelled ?? null })
      state.dialog?.(command.cancelled === true)
      return
    }
    log('command', { type: command.type, command })
    handle(command)
  })
  lines.on('close', () => exit(0))
}

main()
