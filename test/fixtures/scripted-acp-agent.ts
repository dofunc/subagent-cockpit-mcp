// ACP agent that answers from a script, speaking the real protocol over stdio.
// SCRIPTED_ACP: path of the JSON script (read on every request, so tests can change it).
// SCRIPTED_ACP_LOG: JSON-lines file recording every request the agent received.
import { appendFileSync, readFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk'
import type * as acp from '@agentclientprotocol/sdk'

export type Step =
  | { chunk: string; messageId?: string }
  | { chunks: number }
  | { tool: { id: string; title: string; kind?: acp.ToolKind; status?: acp.ToolCallStatus } }
  | { permission: { title?: string; kinds?: acp.PermissionOptionKind[] } }
  | { permissions: string[] }
  | { exec: ExecAsk }
  | { execs: ExecAsk[] }
  | { bash: BashAsk }
  | { sleep: number }
  | { exit: number }
  | { error: string }
  | { question: QuestionAsk }
  | { parallel: Step[] }
  | { update: acp.SessionUpdate }
  /** Runs step after ms without holding the turn, e.g. a question that arrives once the turn is over */
  | { later: { ms: number; step: Step } }
  /** An extension notification, e.g. `_x.ai/test` */
  | { notify: { method: string; params: Record<string, unknown> } }

/** An elicitation/create the agent sends; logged with the client's response. */
export interface QuestionAsk {
  message: string
  /** Form schema; defaults to one single-select field `q0` with options red and blue */
  schema?: acp.ElicitationSchema
  toolCallId?: string
  /** 'url' sends a URL-mode request instead of a form */
  mode?: 'form' | 'url'
  /** 'request' sends a request-scoped question ({ requestId }) instead of one tied to the session */
  scope?: 'session' | 'request'
}

const DEFAULT_QUESTION_SCHEMA: acp.ElicitationSchema = {
  type: 'object',
  properties: { q0: { type: 'string', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] } },
  required: ['q0'],
}

/** A codex-shaped command approval: rawInput.command, codex option ids and names. */
export interface ExecAsk {
  command: string
  /** Prefix in the accept_execpolicy_amendment option; omit for no such option */
  prefix?: string
  /** Offer codex's session-scoped allow_for_session option */
  sessionAllow?: boolean
}

/** A Bash approval whose rawInput carries a per-call description. */
export interface BashAsk {
  command: string
  description: string
  /** Shape of the request: Claude's (default), Grok's or OpenCode's raw input and option ids */
  style?: 'claude' | 'grok' | 'opencode'
}

type RawInput = acp.RequestPermissionRequest['toolCall']['rawInput']

/** Option ids and raw input of each agent's shell approval; OpenCode sends no description. */
const BASH_STYLES: Record<NonNullable<BashAsk['style']>, { options: (bash: BashAsk) => acp.PermissionOption[]; rawInput: (bash: BashAsk) => RawInput }> = {
  claude: {
    options: ({ command }) => [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow-with-updates', name: `Yes, and don't ask again for ${command}`, kind: 'allow_always' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' },
    ],
    rawInput: ({ command, description }) => ({ command, description }),
  },
  grok: {
    options: () => [
      { optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
    ],
    rawInput: ({ command, description }) => ({ variant: 'Bash', command, description, is_background: false }),
  },
  opencode: {
    options: () => [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    // The agent runs in the session cwd
    rawInput: ({ command }) => ({ command, workdir: process.cwd() }),
  },
}

export interface Script {
  sessionId?: string
  loadSession?: boolean
  resume?: boolean
  delete?: boolean
  authRequired?: boolean
  /** setConfig holds each session/set_config_option response; exit is how long the process lives on after stdin closes */
  delays?: { initialize?: number; newSession?: number; loadSession?: number; role?: number; cancel?: number | 'never'; delete?: number; setConfig?: number; exit?: number }
  errors?: { load?: boolean; delete?: boolean; setConfig?: boolean }
  configOptions?: acp.SessionConfigOption[]
  replay?: string[]
  /** Steps run inside session/new and session/load, before the response */
  setup?: Step[]
  turns?: Step[][]
  cancelTail?: string[]
  envKeys?: string[]
}

const scriptPath = process.env.SCRIPTED_ACP ?? ''
const logPath = process.env.SCRIPTED_ACP_LOG ?? ''

const script = (): Script => (scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf-8')) : {})
const log = (entry: Record<string, unknown>) => logPath && appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const select = (id: string, category: string, values: string[]): acp.SessionConfigOption => ({
  type: 'select',
  id,
  name: id,
  category,
  currentValue: values[0],
  options: values.map(v => ({ value: v, name: v })),
})

const DEFAULT_CONFIG: acp.SessionConfigOption[] = [
  select('mode', 'mode', ['auto', 'read-only', 'full-access']),
  select('model', 'model', ['gpt-a', 'gpt-b', 'x']),
  select('reasoning_effort', 'thought_level', ['medium', 'low', 'high']),
]

const state = {
  configOptions: script().configOptions ?? DEFAULT_CONFIG,
  turnIndex: 0,
  newCount: 0,
  cancelled: new Set<string>(),
}

log({ event: 'start', env: Object.fromEntries((script().envKeys ?? []).map(k => [k, process.env[k] ?? null])) })
// The argv after the script path, for the command line of GrokAdapter and OpenCodeAdapter
log({ event: 'argv', argv: process.argv.slice(2) })

// Log every outgoing message as written, in full (raw_out)
const stdout = Writable.toWeb(process.stdout).getWriter()
const outgoing = { pending: '', decoder: new TextDecoder() }
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    const lines = `${outgoing.pending}${outgoing.decoder.decode(chunk, { stream: true })}`.split('\n')
    outgoing.pending = lines.pop() ?? ''
    lines.filter(Boolean).forEach(line => log({ event: 'raw_out', message: JSON.parse(line) }))
    return stdout.write(chunk)
  },
  close: () => stdout.close(),
  abort: reason => stdout.abort(reason),
})
// Log every incoming message in wire order, before the SDK dispatches it (wire, and raw_in in full)
const wire = { pending: '' }
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => {
      const lines = `${wire.pending}${chunk.toString('utf-8')}`.split('\n')
      wire.pending = lines.pop() ?? ''
      lines.filter(Boolean).forEach(line => {
        const msg = JSON.parse(line)
        log({ event: 'wire', method: msg.method ?? null, outcome: msg.result?.outcome?.outcome ?? null, action: msg.result?.action ?? null })
        log({ event: 'raw_in', message: msg })
      })
      controller.enqueue(new Uint8Array(chunk))
    })
    process.stdin.once('end', () => controller.close())
  },
})

const conn = new AgentSideConnection(client => {
  const update = (sessionId: string, u: acp.SessionUpdate) => client.sessionUpdate({ sessionId, update: u })
  const text = (sessionId: string, t: string, messageId?: string) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t }, ...(messageId ? { messageId } : {}) })

  const ALL_KINDS: acp.PermissionOptionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always']

  async function ask(sessionId: string, title: string, kinds = ALL_KINDS): Promise<void> {
    const response = await client.requestPermission({
      sessionId,
      toolCall: { toolCallId: `call-${title}`, title, kind: 'execute' },
      options: kinds.map(kind => ({ optionId: `opt-${kind}`, name: kind, kind })),
    })
    log({ event: 'permission', title, outcome: response.outcome })
  }

  async function askExec(sessionId: string, exec: ExecAsk): Promise<void> {
    const options: acp.PermissionOption[] = [
      { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
      ...(exec.sessionAllow ? [{ optionId: 'allow_for_session', name: 'Yes, and don\'t ask again for this command in this session', kind: 'allow_always' as const }] : []),
      ...(exec.prefix !== undefined ? [{ optionId: 'accept_execpolicy_amendment', name: `Yes, and don't ask again for commands that start with \`${exec.prefix}\``, kind: 'allow_always' as const }] : []),
      { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
    ]
    const response = await client.requestPermission({
      sessionId,
      toolCall: { toolCallId: `exec-${exec.command}`, title: 'Run command', kind: 'execute', status: 'pending', rawInput: { command: exec.command, cwd: process.cwd() } },
      options,
    })
    log({ event: 'permission', title: exec.command, outcome: response.outcome })
  }

  async function askBash(sessionId: string, bash: BashAsk): Promise<void> {
    const { options, rawInput } = BASH_STYLES[bash.style ?? 'claude']
    const response = await client.requestPermission({
      sessionId,
      toolCall: { toolCallId: `bash-${bash.description}`, title: bash.command, kind: 'execute', status: 'pending', rawInput: rawInput(bash) },
      options: options(bash),
    })
    log({ event: 'permission', title: `${bash.command}#${bash.description}`, outcome: response.outcome })
  }

  async function askQuestion(sessionId: string, question: QuestionAsk): Promise<void> {
    const { message } = question
    const scope = question.scope === 'request' ? { requestId: `req-${message}` } : { sessionId, toolCallId: question.toolCallId }
    const request: acp.CreateElicitationRequest = question.mode === 'url'
      ? { ...scope, mode: 'url', message, elicitationId: `el-${message}`, url: 'https://example.com/form' }
      : { ...scope, mode: 'form', message, requestedSchema: question.schema ?? DEFAULT_QUESTION_SCHEMA }
    await client.createElicitation(request).then(
      response => log({ event: 'question', message, response }),
      (err: RequestError) => log({ event: 'question', message, error: err.code }),
    )
  }

  async function runStep(sessionId: string, step: Step): Promise<void> {
    if ('chunk' in step) return text(sessionId, step.chunk, step.messageId)
    if ('chunks' in step) {
      for (let i = 0; i < step.chunks; i++) await text(sessionId, `c${i};`)
      return
    }
    if ('tool' in step) {
      return update(sessionId, { sessionUpdate: 'tool_call', toolCallId: step.tool.id, title: step.tool.title, kind: step.tool.kind ?? 'execute', status: step.tool.status ?? 'pending' })
    }
    if ('permission' in step) return ask(sessionId, step.permission.title ?? 'run command', step.permission.kinds)
    if ('permissions' in step) {
      await Promise.all(step.permissions.map(title => ask(sessionId, title)))
      return
    }
    if ('exec' in step) return askExec(sessionId, step.exec)
    if ('bash' in step) return askBash(sessionId, step.bash)
    if ('execs' in step) {
      await Promise.all(step.execs.map(exec => askExec(sessionId, exec)))
      return
    }
    if ('sleep' in step) {
      const until = Date.now() + step.sleep
      while (Date.now() < until && !state.cancelled.has(sessionId)) await sleep(20)
      return
    }
    if ('exit' in step) {
      log({ event: 'exit' })
      process.exit(step.exit)
    }
    if ('error' in step) throw new RequestError(-32603, step.error)
    if ('question' in step) return askQuestion(sessionId, step.question)
    if ('parallel' in step) {
      await Promise.all(step.parallel.map(s => runStep(sessionId, s)))
      return
    }
    if ('update' in step) return update(sessionId, step.update)
    if ('notify' in step) return client.notify(step.notify.method, step.notify.params)
    if ('later' in step) {
      const { ms, step: next } = step.later
      setTimeout(() => runStep(sessionId, next).catch((err: Error) => log({ event: 'later_failed', message: err.message })), ms)
    }
  }

  async function finishCancelled(sessionId: string): Promise<acp.PromptResponse> {
    const s = script()
    for (const t of s.cancelTail ?? []) await text(sessionId, t)
    if (s.delays?.cancel === 'never') await new Promise(() => {})
    await sleep(typeof s.delays?.cancel === 'number' ? s.delays.cancel : 0)
    return { stopReason: 'cancelled' }
  }

  const agent: acp.Agent = {
    async initialize(params) {
      log({ event: 'initialize', capabilities: params.clientCapabilities ?? null })
      await sleep(script().delays?.initialize ?? 0)
      const s = script()
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: s.loadSession ?? true,
          sessionCapabilities: {
            ...(s.resume ? { resume: {} } : {}),
            ...(s.delete ? { delete: {} } : {}),
          },
        },
        authMethods: [],
      }
    },
    async newSession(params) {
      const s = script()
      log({ event: 'new', cwd: params.cwd, meta: params._meta ?? null })
      await sleep(s.delays?.newSession ?? 0)
      if (s.authRequired) throw RequestError.authRequired()
      state.newCount++
      const sessionId = s.sessionId ?? `s-${process.pid}-${state.newCount}`
      for (const step of s.setup ?? []) await runStep(sessionId, step)
      return { sessionId, configOptions: state.configOptions }
    },
    async loadSession(params) {
      const s = script()
      log({ event: 'load', sessionId: params.sessionId, meta: params._meta ?? null })
      await sleep(s.delays?.loadSession ?? 0)
      if (s.errors?.load) throw new RequestError(-32603, 'load failed')
      for (const t of s.replay ?? []) await text(params.sessionId, t)
      for (const step of s.setup ?? []) await runStep(params.sessionId, step)
      return { configOptions: state.configOptions }
    },
    async resumeSession(params) {
      log({ event: 'resume', sessionId: params.sessionId, meta: params._meta ?? null })
      return { configOptions: state.configOptions }
    },
    async deleteSession(params) {
      const s = script()
      log({ event: 'delete', sessionId: params.sessionId })
      await sleep(s.delays?.delete ?? 0)
      if (s.errors?.delete) throw new RequestError(-32603, 'delete failed')
      return {}
    },
    // Grok's own delete method
    async extMethod(method, params) {
      if (method !== '_x.ai/session/delete') throw RequestError.methodNotFound(method)
      const s = script()
      log({ event: 'delete', sessionId: params.sessionId, method })
      await sleep(s.delays?.delete ?? 0)
      return { success: !s.errors?.delete }
    },
    async authenticate() {
      log({ event: 'authenticate' })
      return {}
    },
    async setSessionConfigOption(params) {
      const value = 'value' in params ? params.value : null
      log({ event: 'set_config', configId: params.configId, value })
      await sleep(script().delays?.setConfig ?? 0)
      log({ event: 'set_config_done', configId: params.configId, value })
      if (script().errors?.setConfig) throw new RequestError(-32603, 'set config failed')
      state.configOptions = state.configOptions.map(o => (o.id === params.configId && o.type === 'select' && typeof value === 'string' ? { ...o, currentValue: value } : o))
      return { configOptions: state.configOptions }
    },
    async prompt(params) {
      const promptText = params.prompt.map(b => (b.type === 'text' ? b.text : '')).join('')
      log({ event: 'prompt', text: promptText })
      const { sessionId } = params
      state.cancelled.delete(sessionId)
      if (promptText.startsWith('[subagent-cockpit]')) {
        await sleep(script().delays?.role ?? 0)
        await text(sessionId, 'OK')
        return { stopReason: 'end_turn' }
      }
      const steps = script().turns?.[state.turnIndex++] ?? [{ chunk: 'done' }]
      for (const step of steps) {
        if (state.cancelled.has(sessionId)) return finishCancelled(sessionId)
        await runStep(sessionId, step)
      }
      if (state.cancelled.has(sessionId)) return finishCancelled(sessionId)
      return { stopReason: 'end_turn' }
    },
    async cancel(params) {
      log({ event: 'cancel', sessionId: params.sessionId })
      state.cancelled.add(params.sessionId)
    },
  }
  return agent
}, ndJsonStream(output, input))

conn.closed.then(async () => {
  await sleep(script().delays?.exit ?? 0)
  log({ event: 'exited' })
  process.exit(0)
})
