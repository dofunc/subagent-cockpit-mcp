import type { JsonValue } from '../../types'
import type { TranscriptParser } from '../transcript'
import { obj } from './fields'

/** The task tool's result: the subagent's reply inside a `<subagent>` tag, which Markdown would swallow along with the reply's formatting */
const SUBAGENT_RESULT = /^<subagent sessionID="[^"]*" state="([^"]*)">\n?([\s\S]*?)\n?<\/subagent>\s*$/

/** A tool content entry with the `<subagent>` tag taken off its text, and the state the tag carried. */
function unwrap(entry: JsonValue): { entry: JsonValue; state?: string } {
  const block = obj(obj(entry).content)
  const match = typeof block.text === 'string' ? SUBAGENT_RESULT.exec(block.text) : null
  return match ? { entry: { ...obj(entry), content: { ...block, text: match[2] } }, state: match[1] } : { entry }
}

/**
 * OpenCode streams the work of its subagents into the parent session, each update marked with
 * `_meta["opencode/child-session"]`; it becomes `child_session`, which keeps such items apart. The task tool
 * that ran a subagent returns its reply wrapped in `<subagent>`; the wrapper goes, and a state other than
 * `completed` becomes `subagent_state`.
 */
export const opencode: TranscriptParser = {
  update(update) {
    const child = obj(obj(update._meta)['opencode/child-session'])
    const unwrapped = Array.isArray(update.content) ? update.content.map(unwrap) : []
    const state = unwrapped.find(u => u.state !== undefined)?.state
    if (typeof child.id !== 'string' && state === undefined) return undefined
    return {
      update: {
        ...update,
        ...(typeof child.id === 'string' ? { child_session: { id: child.id, title: child.title ?? null } } : {}),
        ...(state === undefined ? {} : { content: unwrapped.map(u => u.entry) }),
        ...(state === undefined || state === 'completed' ? {} : { subagent_state: state }),
      },
    }
  },
}
