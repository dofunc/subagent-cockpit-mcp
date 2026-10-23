import type { AcpWireMessage, JsonObject, JsonValue, ConversationActivity, ConversationItem, ConversationItemKind, Conversation, TruncatedMessage } from '../types'
import { PARSERS } from './parsers'
import { WEBUI_ITEM_LIMIT, WEBUI_LOG_LIMIT } from './protocol'

type Direction = 'in' | 'out'

/** What a parser makes of one message or update. */
export interface Parsed {
  /** Apply this session update with the generic rules; omitted, nothing is applied (the message stays on the protocol log) */
  update?: JsonObject
  /** One-line event in the conversation, e.g. `hook`, `turn_summary`, `session_summary` */
  event?: { name: string; data: JsonObject }
  /** Latest values merged into the session info */
  info?: JsonObject
}

export interface ParserContext {
  /** The item already in the view under this id, e.g. `tool:<toolCallId>` */
  item(id: string): ConversationItem | undefined
}

/**
 * One platform's reading of its own structures: extension methods, non-standard updates and `_meta` fields.
 * A hook that returns undefined leaves the generic rules in charge. Parsers live in ./parsers, one per adapter.
 */
export interface TranscriptParser {
  /** A session update, before the generic rules */
  update?(update: JsonObject, context: ParserContext): Parsed | undefined
  /** A request, notification or unmatched response the generic rules do not know */
  message?(message: AcpWireMessage, context: ParserContext): Parsed | undefined
  /** The session/prompt result, e.g. usage kept outside the standard field */
  promptResult?(result: JsonObject): JsonObject
}

/** Streamed chunks that concatenate into one item, by sessionUpdate. */
const CHUNK_KINDS: Record<string, ConversationItemKind> = {
  user_message_chunk: 'user_message',
  agent_message_chunk: 'message',
  agent_thought_chunk: 'thought',
  session_message_chunk: 'session_message',
  compaction_summary_chunk: 'compaction',
}

/** Updates that become one item each, by sessionUpdate. */
const SINGLE_KINDS: Record<string, ConversationItemKind> = {
  notice: 'notice',
  compaction_update: 'compaction',
  subagent_update: 'subagent',
  session_message: 'session_message',
}

/** Requests whose results describe the session rather than a conversation entry. */
const SETUP_METHODS = new Set(['initialize', 'session/new', 'session/load', 'session/resume'])

/** Methods behind each item kind created from a request, for naming the method of an error response. */
const REQUEST_METHODS: Partial<Record<ConversationItemKind, string>> = {
  prompt: 'session/prompt',
  approval: 'session/request_permission',
  question: 'elicitation/create',
}

/** Item ids of requests whose responses only go to the protocol log */
const HIDDEN_PREFIX = 'hidden:'

export const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requestKey = (direction: Direction, id: string | number) => `${direction}:${typeof id}:${id}`

export function createConversation(mcpId: string, session: string, opened: Extract<ConversationActivity, { kind: 'session_opened' }>): Conversation {
  const { subagent, adapter, cwd, title, state } = opened
  return {
    session, mcp_id: mcpId, subagent, adapter, cwd, title, state,
    cancelling: false, closed: null, info: {}, items: [], log: [], requests: {}, version: 0,
  }
}

/**
 * Apply one activity in place; returns the session for chaining. The webui process and the browser
 * run the same code, so a browser that starts from `init` and applies the later activities ends up
 * with what the webui process holds.
 */
export function applyActivity(view: Conversation, at: number, activity: ConversationActivity): Conversation {
  switch (activity.kind) {
    case 'acp':
      applyMessage(view, at, activity.direction, activity.message)
      break
    case 'turn_started':
      pushItem(view, { id: `prompt:${activity.turn_id}`, kind: 'prompt', at, turn_id: activity.turn_id, data: { internal: activity.internal }, log: [] })
      break
    case 'turn_finished': {
      const result = findItem(view, `prompt:${activity.turn_id}`)?.data.result
      const { stopReason = null, usage = null } = isObject(result) ? result : {}
      // The context as the turn left it: the latest usage_update, when the agent sends one with a window size
      const { used = null, size = null } = isObject(view.info.usage) ? view.info.usage : {}
      const context = typeof size === 'number' && size > 0 ? { used, size } : null
      pushItem(view, {
        id: `turn:${activity.turn_id}`, kind: 'turn', at, turn_id: activity.turn_id,
        data: { outcome: activity.outcome, error: activity.error, stopReason, usage, context }, log: [],
      })
      break
    }
    case 'approval': {
      const item = view.items.findLast(i => i.kind === 'approval' && i.data.approval_id === undefined && toolCallId(i) === activity.tool_call_id)
      item && (item.data.approval_id = activity.approval_id)
      break
    }
    case 'approval_resolved': {
      const item = view.items.findLast(i => i.kind === 'approval' && i.data.approval_id === activity.approval_id)
      item && Object.assign(item.data, { resolution: activity.resolution, option_id: activity.option_id })
      break
    }
    case 'auto_approved': {
      const item = view.items.findLast(i => i.kind === 'approval' && i.data.resolution === undefined && toolCallId(i) === activity.tool_call_id)
      item && Object.assign(item.data, { resolution: 'auto', option_id: activity.option_id })
      break
    }
    case 'question': {
      const item = view.items.findLast(i => i.kind === 'question' && i.data.question_id === undefined)
      item && (item.data.question_id = activity.question_id)
      break
    }
    case 'question_resolved': {
      const item = view.items.findLast(i => i.kind === 'question' && i.data.question_id === activity.question_id)
      item && (item.data.action = activity.action)
      break
    }
    case 'state':
      view.state = activity.state
      view.cancelling = activity.cancelling
      break
    case 'session_opened':
      Object.assign(view, {
        subagent: activity.subagent, adapter: activity.adapter, cwd: activity.cwd, title: activity.title,
        state: activity.state, closed: null, requests: {},
      })
      break
    case 'session_closed':
      view.closed = activity.reason
      break
  }
  view.items.length > WEBUI_ITEM_LIMIT && view.items.splice(0, view.items.length - WEBUI_ITEM_LIMIT)
  view.version++
  return view
}

function applyMessage(view: Conversation, at: number, direction: Direction, message: AcpWireMessage | TruncatedMessage): void {
  const seq = (view.log.at(-1)?.seq ?? 0) + 1
  view.log.push({ seq, at, direction, message })
  view.log.length > WEBUI_LOG_LIMIT && view.log.splice(0, view.log.length - WEBUI_LOG_LIMIT)

  if ('truncated' in message) {
    pushItem(view, { id: `raw:${seq}`, kind: 'raw', at, turn_id: currentTurn(view), data: { direction, ...message }, log: [seq] })
    return
  }
  if (message.method === undefined) {
    applyResponse(view, at, direction, seq, message)
    return
  }
  const itemId = applyRequest(view, at, direction, seq, message, message.method)
  message.id !== undefined && message.id !== null && (view.requests[requestKey(direction, message.id)] = itemId)
}

/** A request or notification; returns the id of the item its response belongs to. */
function applyRequest(view: Conversation, at: number, direction: Direction, seq: number, message: AcpWireMessage, method: string): string {
  const params = isObject(message.params) ? message.params : {}
  const turn = currentTurn(view)
  if (SETUP_METHODS.has(method)) return `info:${method}`
  if (method === 'session/update' && isObject(params.update)) {
    applyUpdate(view, at, seq, params.update)
    return `raw:${seq}`
  }
  if (method === 'session/prompt') {
    const pending = view.items.findLast(i => i.kind === 'prompt' && i.data.prompt === undefined)
    if (pending) {
      Object.assign(pending.data, params)
      pending.log.push(seq)
      return pending.id
    }
    return pushItem(view, { id: `prompt:${seq}`, kind: 'prompt', at, turn_id: turn, data: { internal: false, ...params }, log: [seq] })
  }
  if (method === 'session/request_permission') return pushItem(view, { id: `approval:${seq}`, kind: 'approval', at, turn_id: turn, data: { ...params }, log: [seq] })
  if (method === 'elicitation/create') return pushItem(view, { id: `question:${seq}`, kind: 'question', at, turn_id: turn, data: { ...params }, log: [seq] })
  if (method === 'session/set_config_option') {
    const data = { event: 'config', method, configId: params.configId ?? null, value: params.value ?? null }
    return pushItem(view, { id: `event:${seq}`, kind: 'event', at, turn_id: turn, data, log: [seq] })
  }
  const parsed = parserOf(view)?.message?.(message, contextOf(view))
  if (parsed) {
    applyParsed(view, at, seq, parsed)
    return `${HIDDEN_PREFIX}${seq}`
  }
  return pushItem(view, { id: `raw:${seq}`, kind: 'raw', at, turn_id: turn, data: { direction, method, id: message.id ?? null, params: message.params ?? null }, log: [seq] })
}

/** A response travels the opposite way of its request. */
function applyResponse(view: Conversation, at: number, direction: Direction, seq: number, message: AcpWireMessage): void {
  const id = message.id ?? null
  const key = id === null ? null : requestKey(direction === 'in' ? 'out' : 'in', id)
  const itemId = key === null ? undefined : view.requests[key]
  const item = itemId === undefined ? undefined : findItem(view, itemId)
  key !== null && delete view.requests[key]

  if (message.error) {
    const method = itemId?.startsWith('info:') ? itemId.slice('info:'.length) : item && (REQUEST_METHODS[item.kind] ?? item.data.method)
    item?.log.push(seq)
    pushItem(view, { id: `error:${seq}`, kind: 'error', at, turn_id: currentTurn(view), data: { method: method ?? null, id, direction, error: message.error }, log: [seq] })
    return
  }
  const result = message.result ?? null
  isObject(result) && Array.isArray(result.configOptions) && (view.info.configOptions = result.configOptions)
  if (itemId?.startsWith('info:') && isObject(result)) {
    const { sessionId: _sessionId, _meta: _ignored, ...fields } = result
    Object.assign(view.info, fields)
    return
  }
  if (itemId?.startsWith(HIDDEN_PREFIX)) return
  if (item) {
    const promptResult = parserOf(view)?.promptResult
    item.data.result = item.kind === 'prompt' && promptResult && isObject(result) ? promptResult(result) : result
    item.log.push(seq)
    return
  }
  const parsed = parserOf(view)?.message?.(message, contextOf(view))
  if (parsed) {
    applyParsed(view, at, seq, parsed)
    return
  }
  pushItem(view, { id: `raw:${seq}`, kind: 'raw', at, turn_id: currentTurn(view), data: { direction, id, result }, log: [seq] })
}

/** A session update: the adapter's parser has the first word, then the generic rules. */
function applyUpdate(view: Conversation, at: number, seq: number, update: JsonObject): void {
  const parsed = parserOf(view)?.update?.(update, contextOf(view))
  parsed ? applyParsed(view, at, seq, parsed) : applyGenericUpdate(view, at, seq, update)
}

/** What a parser made of a message: its update through the generic rules, its event as an item, its info merged. */
function applyParsed(view: Conversation, at: number, seq: number, { update, event, info }: Parsed): void {
  info && Object.assign(view.info, info)
  event && pushItem(view, { id: `event:${seq}`, kind: 'event', at, turn_id: currentTurn(view), data: { event: event.name, ...event.data }, log: [seq] })
  update && applyGenericUpdate(view, at, seq, update)
}

const parserOf = (view: Conversation): TranscriptParser | undefined => PARSERS[view.adapter]

const contextOf = (view: Conversation): ParserContext => ({ item: id => findItem(view, id) })

/** The child session an update came from (e.g. an OpenCode subagent); parsers put it in `child_session`. */
const childOf = (fields: JsonObject): JsonValue | undefined => (isObject(fields.child_session) ? fields.child_session.id : undefined)

function applyGenericUpdate(view: Conversation, at: number, seq: number, update: JsonObject): void {
  const { sessionUpdate, ...fields } = update
  const kind = typeof sessionUpdate === 'string' ? sessionUpdate : ''
  const turn = currentTurn(view)
  const single = SINGLE_KINDS[kind]
  const chunk = CHUNK_KINDS[kind]

  if (chunk) {
    const last = view.items.at(-1)
    const sameMessage = (field: string) => last?.data[field] === undefined || fields[field] === undefined || last.data[field] === fields[field]
    const sameChild = last !== undefined && childOf(last.data) === childOf(fields)
    if (last?.kind === chunk && last.data.sessionUpdate === kind && last.turn_id === turn && sameChild && sameMessage('messageId') && sameMessage('compactionId')) {
      appendContent(last, fields.content)
      last.log.push(seq)
      return
    }
    pushItem(view, { id: `${chunk}:${seq}`, kind: chunk, at, turn_id: turn, data: { sessionUpdate: kind, ...fields, content: fields.content === undefined ? [] : [fields.content] }, log: [seq] })
    return
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = `tool:${typeof fields.toolCallId === 'string' ? fields.toolCallId : seq}`
    const item = findItem(view, id)
    if (item) {
      Object.assign(item.data, fields)
      item.log.push(seq)
      return
    }
    pushItem(view, { id, kind: 'tool', at, turn_id: turn, data: { sessionUpdate: kind, ...fields }, log: [seq] })
    return
  }
  if (kind === 'plan' || kind === 'plan_update' || kind === 'plan_removed') {
    const plan = isObject(fields.plan) ? fields.plan : {}
    const planId = kind === 'plan' ? '' : String((kind === 'plan_update' ? plan.planId : fields.planId) ?? '')
    const item = findItem(view, `plan:${planId}`)
    if (!item) {
      kind === 'plan_removed'
        ? pushItem(view, { id: `raw:${seq}`, kind: 'raw', at, turn_id: turn, data: update, log: [seq] })
        : pushItem(view, { id: `plan:${planId}`, kind: 'plan', at, turn_id: turn, data: { sessionUpdate: kind, ...fields }, log: [seq] })
      return
    }
    // The latest plan replaces the earlier one in place; a removed plan keeps its content
    item.data = kind === 'plan_removed' ? { ...item.data, removed: true } : { sessionUpdate: kind, ...fields }
    item.log.push(seq)
    return
  }
  if (single) {
    pushItem(view, { id: `${single}:${seq}`, kind: single, at, turn_id: turn, data: update, log: [seq] })
    return
  }
  if (applyInfo(view, kind, fields)) return
  pushItem(view, { id: `raw:${seq}`, kind: 'raw', at, turn_id: turn, data: update, log: [seq] })
}

/** Latest-value updates kept in `info`; returns false for anything else. */
function applyInfo(view: Conversation, kind: string, fields: JsonObject): boolean {
  const { info } = view
  switch (kind) {
    case 'usage_update':
      info.usage = fields
      return true
    case 'available_commands_update':
      info.availableCommands = fields.availableCommands ?? []
      return true
    case 'current_mode_update':
      info.modes = { ...(isObject(info.modes) ? info.modes : {}), currentModeId: fields.currentModeId ?? null }
      return true
    case 'config_option_update':
      info.configOptions = fields.configOptions ?? []
      return true
    case 'session_info_update':
      info.sessionInfo = fields
      'title' in fields && (view.title = typeof fields.title === 'string' ? fields.title : null)
      return true
    default:
      return false
  }
}

/** Text chunks join the previous text block; any other block is kept as its own. */
function appendContent(item: ConversationItem, block: JsonValue | undefined): void {
  const content = Array.isArray(item.data.content) ? item.data.content : []
  const last = content.at(-1)
  if (isObject(block) && block.type === 'text' && isObject(last) && last.type === 'text') {
    content[content.length - 1] = { ...last, text: `${last.text ?? ''}${block.text ?? ''}` }
  } else if (block !== undefined) {
    content.push(block)
  }
  item.data.content = content
}

function pushItem(view: Conversation, item: ConversationItem): string {
  view.items.push(item)
  return item.id
}

function findItem(view: Conversation, id: string): ConversationItem | undefined {
  return view.items.findLast(i => i.id === id)
}

function toolCallId(item: ConversationItem): JsonValue | undefined {
  return isObject(item.data.toolCall) ? item.data.toolCall.toolCallId : undefined
}

/** The turn in progress: the latest prompt, unless its turn already finished. */
function currentTurn(view: Conversation): number | null {
  const last = view.items.findLast(i => i.kind === 'prompt' || i.kind === 'turn')
  return last?.kind === 'prompt' ? last.turn_id : null
}
