import type { TranscriptParser } from '../transcript'
import { authStatus, obj } from './fields'

/**
 * codex-acp: command output only arrives as `_meta.terminal_output_delta` on tool_call_update, the thread
 * status rides on session_info_update, and the token count of a turn sits in the prompt result's `_meta.quota`.
 */
export const codex: TranscriptParser = {
  update(update, context) {
    const meta = obj(update._meta)
    if (update.sessionUpdate === 'session_info_update' && obj(meta.codex).threadStatus !== undefined) {
      return { update, info: { threadStatus: obj(meta.codex).threadStatus ?? null } }
    }
    const delta = obj(meta.terminal_output_delta).data
    if (update.sessionUpdate !== 'tool_call_update' || typeof delta !== 'string') return undefined
    const earlier = context.item(`tool:${String(update.toolCallId)}`)?.data.terminal_output
    return { update: { ...update, terminal_output: `${typeof earlier === 'string' ? earlier : ''}${delta}` } }
  },
  message: authStatus,
  promptResult(result) {
    const count = obj(obj(obj(result._meta).quota).token_count)
    if (result.usage !== undefined || count.totalTokens === undefined) return result
    // token_count names the cache and reasoning fields its own way
    const { cachedInputTokens = null, cacheWriteInputTokens = null, reasoningOutputTokens = null, ...rest } = count
    return { ...result, usage: { ...rest, cachedReadTokens: cachedInputTokens, cachedWriteTokens: cacheWriteInputTokens, thoughtTokens: reasoningOutputTokens } }
  },
}
