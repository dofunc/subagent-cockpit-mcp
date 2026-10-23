import type { JsonObject } from '../../types'
import type { Parsed, TranscriptParser } from '../transcript'
import { obj } from './fields'

/** Updates that repeat what the standard turn end, tool calls and approvals already show */
const REPEATED = new Set(['turn_completed', 'response_completed', 'tool_call_delta_chunk', 'pending_interaction', 'interaction_resolved'])

/** grok's own state syncing: setup phases, MCP servers, the session list, the prompt queue */
const INTERNAL = /^_x\.ai\/(session\/setup|session\/prompt_complete|mcp\/|mcp_initialized|sessions\/changed|queue\/changed)/

/** grok's own sessionUpdate types; the standard ones are left to the generic rules. */
function update(entry: JsonObject): Parsed | undefined {
  const type = String(entry.sessionUpdate ?? '')
  if (REPEATED.has(type)) return {}
  if (type === 'hook_execution') return { event: { name: 'hook', data: { name: entry.event_name ?? null, runs: entry.runs ?? [] } } }
  if (type === 'last_turn_summary') return { event: { name: 'turn_summary', data: { text: entry.summary ?? null } } }
  if (type === 'session_summary_generated') return { event: { name: 'session_summary', data: { text: entry.session_summary ?? null } } }
  return undefined
}

/**
 * Grok Build sends most of its own updates wrapped in `_x.ai/session_notification`, plus a stream of
 * internal `_x.ai/...` notifications and responses to its own requests (e.g. `skills-reload`).
 */
export const grok: TranscriptParser = {
  update,
  message(message) {
    if (message.method === '_x.ai/session_notification') {
      const wrapped = obj(obj(message.params).update)
      return update(wrapped) ?? { update: wrapped }
    }
    if (message.method === undefined) return {}
    return INTERNAL.test(message.method) ? {} : undefined
  },
  /**
   * grok leaves the standard usage out and reports the turn in `_meta`: its inputTokens include the cache
   * reads, and the top-level total counts reasoning too. Cache creation is passed on as reported.
   */
  promptResult(result) {
    const meta = obj(result._meta)
    const usage = obj(meta.usage)
    if (result.usage !== undefined || typeof usage.inputTokens !== 'number') return result
    const cached = typeof usage.cachedReadTokens === 'number' ? usage.cachedReadTokens : 0
    return {
      ...result,
      usage: {
        totalTokens: meta.totalTokens ?? usage.totalTokens ?? null,
        inputTokens: usage.inputTokens - cached,
        outputTokens: usage.outputTokens ?? null,
        cachedReadTokens: cached,
        cachedWriteTokens: usage.cacheCreationTokens ?? null,
        thoughtTokens: usage.reasoningTokens ?? null,
      },
    }
  },
}
