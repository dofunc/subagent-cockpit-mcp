import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AcpWireMessage, JsonObject, JsonValue, ConversationActivity, ConversationItem, ConversationItemKind, Conversation } from '../../src/types'
import { WEBUI_ITEM_LIMIT, WEBUI_LOG_LIMIT } from '../../src/webui/protocol'
import { PARSERS } from '../../src/webui/parsers'
import type { TranscriptParser } from '../../src/webui/transcript'
import { applyActivity, createConversation, isObject } from '../../src/webui/transcript'

const OPENED: Extract<ConversationActivity, { kind: 'session_opened' }> = {
  kind: 'session_opened', subagent: 'coder', adapter: 'grok', cwd: '/repo', title: null, state: 'IDLE', reconnected: false,
}

const acp = (direction: 'in' | 'out', message: Omit<AcpWireMessage, 'jsonrpc'>): ConversationActivity => ({ kind: 'acp', direction, message: { jsonrpc: '2.0', ...message } })
const update = (body: JsonObject): ConversationActivity => acp('in', { method: 'session/update', params: { sessionId: 's1', update: body } })
const chunk = (sessionUpdate: string, text: string, messageId?: string): ConversationActivity =>
  update({ sessionUpdate, content: { type: 'text', text }, ...(messageId === undefined ? {} : { messageId }) })
const started = (turn_id: number, internal = false): ConversationActivity => ({ kind: 'turn_started', turn_id, internal })
const finished = (turn_id: number): ConversationActivity => ({ kind: 'turn_finished', turn_id, outcome: 'done', error: null })

/** A fresh session view of the adapter with the activities applied in order, one millisecond apart. */
function feedAs(adapter: string, ...activities: ConversationActivity[]): Conversation {
  const view = createConversation('mcp-1', `${adapter}_s1`, { ...OPENED, adapter })
  activities.forEach((activity, index) => applyActivity(view, index, activity))
  return view
}

const feed = (...activities: ConversationActivity[]) => feedAs('grok', ...activities)

const ofKind = (view: Conversation, kind: ConversationItemKind) => view.items.filter(i => i.kind === kind)
const contents = (view: Conversation, kind: ConversationItemKind) => ofKind(view, kind).map(i => i.data.content)
const textBlocks = (...texts: string[]) => texts.map(text => [{ type: 'text', text }])

function item(view: Conversation, id: string): ConversationItem {
  const found = view.items.find(i => i.id === id)
  assert.ok(found, `no item ${id}`)
  return found
}

/** Value at a path of plain JSON objects, undefined as soon as one step is missing. */
const field = (value: JsonValue | undefined, ...path: string[]): JsonValue | undefined =>
  path.reduce<JsonValue | undefined>((current, key) => (isObject(current) ? current[key] : undefined), value)

/** seq of the log entries whose message matches. */
const seqsWhere = (view: Conversation, match: (message: AcpWireMessage) => boolean) =>
  view.log.filter(({ message }) => !('truncated' in message) && match(message)).map(({ seq }) => seq)

describe('transcript: streamed chunks', () => {
  test('U206 chunks of one message join; a new message, a tool call or a new turn starts another item', () => {
    const sameId = feed(started(1), chunk('agent_message_chunk', 'a', 'm1'), chunk('agent_message_chunk', 'b', 'm1'), chunk('agent_message_chunk', 'c', 'm1'))
    assert.deepEqual(contents(sameId, 'message'), textBlocks('abc'))

    const twoIds = feed(started(1), chunk('agent_message_chunk', 'a', 'm1'), chunk('agent_message_chunk', 'b', 'm2'))
    assert.deepEqual(contents(twoIds, 'message'), textBlocks('a', 'b'))

    // Either side missing a messageId joins
    const noId = feed(started(1), chunk('agent_message_chunk', 'a'), chunk('agent_message_chunk', 'b'), chunk('agent_message_chunk', 'c', 'm1'))
    assert.deepEqual(contents(noId, 'message'), textBlocks('abc'))

    const aroundTool = feed(
      started(1),
      chunk('agent_message_chunk', 'a', 'm1'),
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' }),
      chunk('agent_message_chunk', 'b', 'm1'),
    )
    assert.deepEqual(contents(aroundTool, 'message'), textBlocks('a', 'b'))

    const acrossTurns = feed(started(1), chunk('agent_message_chunk', 'a', 'm1'), finished(1), started(2), chunk('agent_message_chunk', 'b', 'm1'))
    assert.deepEqual(contents(acrossTurns, 'message'), textBlocks('a', 'b'))
    assert.deepEqual(ofKind(acrossTurns, 'message').map(i => i.turn_id), [1, 2])

    const interleaved = feed(
      started(1),
      chunk('agent_thought_chunk', 'x'),
      chunk('agent_message_chunk', 'a'),
      chunk('agent_thought_chunk', 'y'),
      chunk('agent_message_chunk', 'b'),
    )
    assert.deepEqual(interleaved.items.map(i => i.kind), ['prompt', 'thought', 'message', 'thought', 'message'])
    assert.deepEqual(contents(interleaved, 'thought'), textBlocks('x', 'y'))

    const otherKinds = feed(
      chunk('user_message_chunk', 'u1'),
      chunk('user_message_chunk', 'u2'),
      update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 's1' } }),
      update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 's2' } }),
      update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c2', content: { type: 'text', text: 's3' } }),
    )
    assert.deepEqual(contents(otherKinds, 'user_message'), textBlocks('u1u2'))
    assert.deepEqual(contents(otherKinds, 'compaction'), textBlocks('s1s2', 's3'))
  })
})

describe('transcript: merging and raw items', () => {
  const unknown: JsonObject = { sessionUpdate: 'future_update', payload: { nested: [1, 2] } }
  const fileEntries: JsonValue = [{ content: 'Swap the client', priority: 'high', status: 'in_progress' }]
  const view = feed(
    acp('out', { id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
    acp('in', { id: 0, result: { protocolVersion: 1, agentInfo: { name: 'grok', version: '1.2.0' }, agentCapabilities: { loadSession: true }, authMethods: [] } }),
    acp('out', { id: 1, method: 'session/new', params: { cwd: '/repo', mcpServers: [] } }),
    acp('in', {
      id: 1,
      result: {
        sessionId: 's1',
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        models: { currentModelId: 'm', availableModels: [{ modelId: 'm', name: 'Model' }] },
        configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'default', options: [] }],
      },
    }),
    started(1),
    acp('out', { id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] } }),
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.ts', kind: 'read', status: 'pending', rawInput: { path: 'a.ts' } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: { type: 'text', text: 'body' } }] }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { bytes: 4 } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' }),
    update({ sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }] }),
    update({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'A', entries: fileEntries } }),
    update({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'B', content: '### Rollout' } }),
    update({ sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'C', uri: 'file:///repo/plan.md' } }),
    update({ sessionUpdate: 'plan_removed', planId: 'A' }),
    update(unknown),
    acp('in', { method: '_x.ai/test', params: { hint: 'ext' } }),
    acp('out', { id: 3, method: '_x.ai/query', params: { q: 1 } }),
    acp('in', { id: 3, error: { code: -32601, message: 'Method not found' } }),
    acp('out', { id: 4, method: 'session/load', params: { sessionId: 'gone', cwd: '/repo', mcpServers: [] } }),
    acp('in', { id: 4, error: { code: -32002, message: 'Session not found' } }),
  )

  test('U207 tool calls merge by toolCallId, keeping fields the updates leave out', () => {
    const tool = item(view, 'tool:t1')
    assert.equal(tool.data.title, 'Read a.ts')
    assert.equal(tool.data.kind, 'read')
    assert.equal(tool.data.status, 'completed')
    assert.deepEqual(tool.data.rawInput, { path: 'a.ts' })
    assert.deepEqual(tool.data.rawOutput, { bytes: 4 })
    assert.deepEqual(tool.data.content, [{ type: 'content', content: { type: 'text', text: 'body' } }])
    assert.deepEqual(tool.log, seqsWhere(view, m => field(m.params, 'update', 'toolCallId') === 't1'))
    assert.equal(tool.log.length, 4)

    // An update with no tool_call before it stands alone
    const orphan = item(view, 'tool:t2')
    assert.equal(orphan.data.sessionUpdate, 'tool_call_update')
    assert.equal(ofKind(view, 'tool').length, 2)
  })

  test('U207 one item per plan; plan_removed marks its plan and keeps the content', () => {
    assert.deepEqual(ofKind(view, 'plan').map(i => i.id), ['plan:', 'plan:A', 'plan:B', 'plan:C'])
    const removed = item(view, 'plan:A')
    assert.equal(removed.data.removed, true)
    assert.deepEqual(field(removed.data.plan, 'entries'), fileEntries)
    assert.deepEqual(item(view, 'plan:B').data.plan, { type: 'markdown', planId: 'B', content: '### Rollout' })
    assert.deepEqual(item(view, 'plan:C').data.plan, { type: 'file', planId: 'C', uri: 'file:///repo/plan.md' })
    assert.equal(item(view, 'plan:B').data.removed, undefined)
    assert.equal(item(view, 'plan:C').data.removed, undefined)
  })

  test('U207 setup responses fill the session info', () => {
    assert.deepEqual(view.info.agentInfo, { name: 'grok', version: '1.2.0' })
    assert.deepEqual(view.info.agentCapabilities, { loadSession: true })
    assert.equal(view.info.protocolVersion, 1)
    assert.deepEqual(view.info.authMethods, [])
    assert.equal(field(view.info.modes, 'currentModeId'), 'default')
    assert.equal(field(view.info.models, 'currentModelId'), 'm')
    assert.equal(Array.isArray(view.info.configOptions) && view.info.configOptions.length, 1)
    assert.equal(view.info.sessionId, undefined)
    assert.equal(view.items.some(i => i.data.method === 'initialize' || i.data.method === 'session/new'), false)
  })

  test('U207 error responses name the method of their request', () => {
    const errors = ofKind(view, 'error')
    assert.deepEqual(errors.map(e => e.data.method), ['_x.ai/query', 'session/load'])
    assert.deepEqual(errors.map(e => field(e.data.error, 'message')), ['Method not found', 'Session not found'])
    // The request's item points at the error too
    const request = view.items.find(i => i.kind === 'raw' && i.data.method === '_x.ai/query')
    assert.ok(request)
    assert.deepEqual(request.log, seqsWhere(view, m => m.id === 3))
  })

  test('U207 unknown updates and extension methods stay as received', () => {
    const raws = ofKind(view, 'raw')
    assert.deepEqual(raws.find(r => r.data.sessionUpdate === 'future_update')?.data, unknown)
    const ext = raws.find(r => r.data.method === '_x.ai/test')
    assert.ok(ext)
    assert.deepEqual(ext.data.params, { hint: 'ext' })
    assert.equal(ext.data.direction, 'in')
  })

  test('U207 every item points at log entries that exist', () => {
    const seqs = new Set(view.log.map(e => e.seq))
    view.items.forEach(i => i.log.forEach(seq => assert.ok(seqs.has(seq), `${i.id} -> ${seq}`)))
    assert.deepEqual(item(view, 'prompt:1').log, seqsWhere(view, m => m.method === 'session/prompt'))
  })
})

describe('transcript: approvals, questions and turns', () => {
  test('U222 prompts, approvals, questions and the end of a turn merge with the adapter activities', () => {
    const view = feed(
      started(1, true),
      acp('out', { id: 1, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'role' }] } }),
      { kind: 'state', state: 'RUNNING', cancelling: false },
      acp('in', { id: 0, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [] } }),
      { kind: 'approval', approval_id: 'ap_1', tool_call_id: 't1' },
      { kind: 'approval_resolved', approval_id: 'ap_1', resolution: 'allow', option_id: 'allow_once' },
      acp('out', { id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }),
      acp('in', { id: 1, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't2' }, options: [] } }),
      { kind: 'auto_approved', tool_call_id: 't2', option_id: 'allow_once' },
      acp('in', { id: 2, method: 'elicitation/create', params: { message: 'Pick one', requestedSchema: {} } }),
      { kind: 'question', question_id: 'qu_1' },
      { kind: 'question_resolved', question_id: 'qu_1', action: 'accept' },
      acp('out', { id: 2, result: { action: 'accept', content: { choice: 'a' } } }),
      update({ sessionUpdate: 'session_info_update', title: 'Fix login', updatedAt: null }),
      acp('in', { id: 1, result: { stopReason: 'end_turn', usage: { totalTokens: 10 } } }),
      finished(1),
      { kind: 'state', state: 'IDLE', cancelling: false },
      { kind: 'session_closed', reason: 'idle' },
    )

    const prompt = item(view, 'prompt:1')
    assert.equal(ofKind(view, 'prompt').length, 1)
    assert.equal(prompt.data.internal, true)
    assert.deepEqual(prompt.data.prompt, [{ type: 'text', text: 'role' }])

    const [approval, auto] = ofKind(view, 'approval')
    assert.equal(approval.data.approval_id, 'ap_1')
    assert.equal(approval.data.resolution, 'allow')
    assert.equal(approval.data.option_id, 'allow_once')
    assert.deepEqual(field(approval.data.result, 'outcome', 'optionId'), 'allow_once')
    assert.equal(auto.data.resolution, 'auto')

    const [question] = ofKind(view, 'question')
    assert.equal(question.data.question_id, 'qu_1')
    assert.equal(question.data.action, 'accept')
    assert.deepEqual(field(question.data.result, 'content'), { choice: 'a' })

    const turn = item(view, 'turn:1')
    assert.deepEqual(turn.data, { outcome: 'done', error: null, stopReason: 'end_turn', usage: { totalTokens: 10 } })
    assert.equal(view.title, 'Fix login')
    assert.equal(view.state, 'IDLE')
    assert.equal(view.closed, 'idle')
  })
})

describe('transcript: request ids', () => {
  test('U221 each side numbers its own requests', () => {
    const view = feed(
      started(1),
      acp('out', { id: 7, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } }),
      acp('in', { id: 7, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [] } }),
      acp('out', { id: 7, result: { outcome: { outcome: 'cancelled' } } }),
      acp('in', { id: 7, result: { stopReason: 'cancelled' } }),
    )
    assert.deepEqual(item(view, 'prompt:1').data.result, { stopReason: 'cancelled' })
    assert.deepEqual(ofKind(view, 'approval')[0].data.result, { outcome: { outcome: 'cancelled' } })
  })

  test('U221 number and string ids are different requests', () => {
    const view = feed(
      acp('out', { id: 3, method: '_x.ai/a' }),
      acp('out', { id: '3', method: '_x.ai/b' }),
      acp('in', { id: '3', result: { from: 'b' } }),
      acp('in', { id: 3, result: { from: 'a' } }),
    )
    const raws = ofKind(view, 'raw')
    assert.deepEqual(raws.map(r => [r.data.method, r.data.result]), [['_x.ai/a', { from: 'a' }], ['_x.ai/b', { from: 'b' }]])
  })

  test('U221 a reconnect starts numbering again', () => {
    const view = feed(
      started(1),
      acp('out', { id: 7, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } }),
      { ...OPENED, reconnected: true },
      acp('out', { id: 7, method: 'session/load', params: { sessionId: 's1', cwd: '/repo', mcpServers: [] } }),
      acp('in', { id: 7, result: { modes: { currentModeId: 'plan', availableModes: [] } } }),
    )
    assert.equal(item(view, 'prompt:1').data.result, undefined)
    assert.equal(field(view.info.modes, 'currentModeId'), 'plan')
  })
})

describe('transcript: limits', () => {
  test('U208 items and log keep the latest entries; version counts every activity', () => {
    const view = createConversation('mcp-1', 'grok_s1', OPENED)
    const total = WEBUI_ITEM_LIMIT + 2
    Array.from({ length: total }, (_, index) => update({ sessionUpdate: 'notice', severity: 'info', title: `n${index}` }))
      .forEach((activity, index) => {
        applyActivity(view, index, activity)
        assert.equal(view.version, index + 1)
      })
    assert.equal(view.items.length, WEBUI_ITEM_LIMIT)
    assert.equal(view.log.length, WEBUI_LOG_LIMIT)
    assert.equal(view.items[0].id, 'notice:3')
    assert.equal(field(view.items[0].data, 'title'), 'n2')
    assert.equal(view.log[0].seq, 3)
    assert.equal(view.log.at(-1)?.seq, total)
  })
})

describe('transcript: platform parsers', () => {
  const notify = (method: string, params: JsonObject): ConversationActivity => acp('in', { method, params })
  const prompt = (id: number): ConversationActivity => acp('out', { id, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } })
  const events = (view: Conversation) => ofKind(view, 'event').map(i => i.data)

  test('U223 a parser hides messages, makes events, rewrites updates and fills info and usage; no parser keeps the generic rules', () => {
    const probe: TranscriptParser = {
      message: ({ method }) => (method === '_probe/quiet' ? {} : method === '_probe/event' ? { event: { name: 'probe', data: { n: 1 } } } : undefined),
      update: entry => (entry.sessionUpdate === 'probe_text'
        ? { update: { ...entry, sessionUpdate: 'agent_message_chunk' } }
        : entry.sessionUpdate === 'probe_info' ? { info: { probe: entry.value ?? null } } : undefined),
      promptResult: result => ({ ...result, usage: { totalTokens: 42 } }),
    }
    const activities = [
      started(1),
      prompt(1),
      notify('_probe/quiet', { a: 1 }),
      notify('_probe/event', {}),
      notify('_probe/other', { b: 2 }),
      update({ sessionUpdate: 'probe_text', content: { type: 'text', text: 'hi' } }),
      update({ sessionUpdate: 'probe_info', value: 'x' }),
      acp('in', { id: 1, result: { stopReason: 'end_turn' } }),
      finished(1),
    ]
    PARSERS.probe = probe
    try {
      const view = feedAs('probe', ...activities)
      assert.equal(view.items.some(i => i.data.method === '_probe/quiet'), false)
      assert.equal(seqsWhere(view, m => m.method === '_probe/quiet').length, 1)
      assert.deepEqual(events(view), [{ event: 'probe', n: 1 }])
      assert.deepEqual(ofKind(view, 'raw').map(r => r.data.method), ['_probe/other'])
      assert.deepEqual(contents(view, 'message'), textBlocks('hi'))
      assert.equal(view.info.probe, 'x')
      assert.deepEqual(item(view, 'turn:1').data.usage, { totalTokens: 42 })
    } finally {
      delete PARSERS.probe
    }

    const plain = feedAs('antigravity', ...activities)
    assert.deepEqual(events(plain), [])
    assert.deepEqual(ofKind(plain, 'raw').map(r => r.data.method ?? r.data.sessionUpdate), ['_probe/quiet', '_probe/event', '_probe/other', 'probe_text', 'probe_info'])
    assert.deepEqual(ofKind(plain, 'message'), [])
    assert.equal(plain.info.probe, undefined)
    assert.equal(item(plain, 'turn:1').data.usage, null)
  })

  test('U224 grok: hooks and summaries become events; internal notifications, repeats and stray responses only reach the log', () => {
    const note = (entry: JsonObject) => notify('_x.ai/session_notification', { sessionId: 's1', update: entry })
    const runs = [{ name: 'plugin/team-rules:session_start', status: { status: 'success', elapsed_ms: 95 } }]
    const view = feed(
      started(1),
      prompt(1),
      notify('_x.ai/session/setup', { phase: 'ready' }),
      note({ sessionUpdate: 'hook_execution', event_name: 'session_start', runs }),
      note({ sessionUpdate: 'tool_call_delta_chunk', tool_call_id: 'c1', tool_index: 0, name: 'run_command' }),
      note({ sessionUpdate: 'pending_interaction', tool_call_id: 'c1', kind: 'permission' }),
      note({ sessionUpdate: 'interaction_resolved', tool_call_id: 'c1' }),
      note({ sessionUpdate: 'response_completed', usage: { input_tokens: 24600, output_tokens: 304 } }),
      notify('_x.ai/queue/changed', { queue: [] }),
      notify('_x.ai/sessions/changed', {}),
      acp('in', { id: 1, result: { stopReason: 'end_turn' } }),
      note({ sessionUpdate: 'last_turn_summary', summary: 'Screenshot matches the spec', prompt_id: 'p-1' }),
      note({ sessionUpdate: 'turn_completed', prompt_id: 'p-1', stop_reason: 'end_turn' }),
      notify('_x.ai/session/prompt_complete', { prompt_id: 'p-1' }),
      finished(1),
      acp('in', { id: 99, result: { reloaded: true } }),
      note({ sessionUpdate: 'session_summary_generated', session_summary: 'Screenshot review' }),
    )
    assert.deepEqual(events(view), [
      { event: 'hook', name: 'session_start', runs },
      { event: 'turn_summary', text: 'Screenshot matches the spec' },
      { event: 'session_summary', text: 'Screenshot review' },
    ])
    assert.deepEqual(ofKind(view, 'event').map(i => i.turn_id), [1, 1, null])
    assert.deepEqual(view.items.map(i => i.kind), ['prompt', 'event', 'event', 'turn', 'event'])
    assert.equal(seqsWhere(view, m => m.method === '_x.ai/session_notification').length, 8)
    assert.equal(view.log.length, 15)
  })

  test('U225 codex: auth and thread status go to the info, terminal output deltas join, quota fills the usage', () => {
    const auth = { kind: 'gateway', label: 'Custom model gateway', detail: 'OpenAI' }
    const delta = (status: string, data: string) =>
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-git', status, _meta: { terminal_output_delta: { data, terminal_id: 'exec-git' } } })
    const view = feedAs(
      'codex',
      notify('_auth/status_update', { authStatus: auth }),
      update({ sessionUpdate: 'session_info_update', title: 'Validate input', _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } } }),
      started(1),
      prompt(1),
      update({ sessionUpdate: 'tool_call', toolCallId: 'exec-git', title: 'git status --short', kind: 'execute', status: 'pending' }),
      delta('in_progress', ' M src/api/users.ts\n'),
      delta('completed', '?? src/api/validate.ts\n'),
      acp('in', { id: 1, result: { stopReason: 'end_turn', _meta: { quota: { token_count: { totalTokens: 18545, inputTokens: 8556 } } } } }),
      finished(1),
    )
    assert.deepEqual(view.info.auth, auth)
    assert.deepEqual(view.info.threadStatus, { type: 'active', activeFlags: [] })
    assert.equal(view.title, 'Validate input')
    const tool = item(view, 'tool:exec-git')
    assert.equal(tool.data.terminal_output, ' M src/api/users.ts\n?? src/api/validate.ts\n')
    assert.equal(tool.data.status, 'completed')
    assert.equal(field(item(view, 'turn:1').data.usage, 'totalTokens'), 18545)
    assert.deepEqual(ofKind(view, 'raw'), [])
  })

  test('U226 claude names the tool; opencode keeps a child session\'s chunks apart from the parent\'s', () => {
    const claude = feedAs(
      'claude',
      notify('_auth/status_update', { authStatus: { kind: 'subscription', label: 'Claude subscription' } }),
      started(1),
      update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Read a.ts', kind: 'read', status: 'pending', _meta: { claudeCode: { toolName: 'Read' } } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', status: 'completed', _meta: { claudeCode: { toolName: 'Read' } } }),
    )
    assert.equal(item(claude, 'tool:toolu_1').data.tool_name, 'Read')
    assert.equal(item(claude, 'tool:toolu_1').data.status, 'completed')
    assert.equal(field(claude.info.auth, 'label'), 'Claude subscription')

    // No messageIds, so without the child session all four chunks would join
    const meta = { _meta: { 'opencode/child-session': { id: 'ses_child', parentID: 's1', depth: 1, title: 'Check existing workflows' } } }
    const childChunk = (text: string) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...meta })
    const opencode = feedAs(
      'opencode',
      started(1),
      chunk('agent_message_chunk', 'Looking. '),
      childChunk('Only ci.yml '),
      childChunk('exists.'),
      update({ sessionUpdate: 'tool_call', toolCallId: 'child_read', title: 'read ci.yml', kind: 'read', status: 'completed', ...meta }),
      chunk('agent_message_chunk', 'Done.'),
    )
    const childSession = { id: 'ses_child', title: 'Check existing workflows' }
    assert.deepEqual(contents(opencode, 'message'), textBlocks('Looking. ', 'Only ci.yml exists.', 'Done.'))
    assert.deepEqual(ofKind(opencode, 'message').map(i => i.data.child_session), [undefined, childSession, undefined])
    assert.deepEqual(item(opencode, 'tool:child_read').data.child_session, childSession)

    // The task tool's result loses its <subagent> wrapper; a state other than completed is kept
    const result = (id: string, state: string, text: string) => update({
      sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: `<subagent sessionID="ses_child" state="${state}">\n${text}\n</subagent>` } }],
    })
    const tasks = feedAs(
      'opencode',
      started(1),
      update({ sessionUpdate: 'tool_call', toolCallId: 'task_1', title: 'subagent', kind: 'think', status: 'in_progress' }),
      result('task_1', 'completed', 'Only `ci.yml` exists.'),
      update({ sessionUpdate: 'tool_call', toolCallId: 'task_2', title: 'subagent', kind: 'think', status: 'in_progress' }),
      result('task_2', 'error', 'Aborted'),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'task_3', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '<subagent>kept</subagent>' } }] }),
    )
    const resultText = (id: string) => {
      const content = item(tasks, `tool:${id}`).data.content
      return field(Array.isArray(content) ? content[0] : undefined, 'content', 'text')
    }
    assert.equal(resultText('task_1'), 'Only `ci.yml` exists.')
    assert.equal(item(tasks, 'tool:task_1').data.subagent_state, undefined)
    assert.equal(resultText('task_2'), 'Aborted')
    assert.equal(item(tasks, 'tool:task_2').data.subagent_state, 'error')
    // Not the task tool's shape: left as it is
    assert.equal(resultText('task_3'), '<subagent>kept</subagent>')
  })

  test('U227 session/set_config_option is a config event; a failed one also gets an error item', () => {
    const configOptions = [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'acceptEdits', options: [] }]
    const view = feed(
      acp('out', { id: 5, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'mode', value: 'acceptEdits' } }),
      acp('in', { id: 5, result: { configOptions } }),
      acp('out', { id: 6, method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'grok-9' } }),
      acp('in', { id: 6, error: { code: -32602, message: 'Unknown model: grok-9' } }),
    )
    assert.deepEqual(events(view).map(({ event, method, configId, value }) => ({ event, method, configId, value })), [
      { event: 'config', method: 'session/set_config_option', configId: 'mode', value: 'acceptEdits' },
      { event: 'config', method: 'session/set_config_option', configId: 'model', value: 'grok-9' },
    ])
    const errors = ofKind(view, 'error')
    assert.deepEqual(errors.map(e => [e.data.method, field(e.data.error, 'message')]), [['session/set_config_option', 'Unknown model: grok-9']])
    assert.deepEqual(view.info.configOptions, configOptions)
    assert.deepEqual(ofKind(view, 'raw'), [])
  })
})
