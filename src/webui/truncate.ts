import type { SessionActivity } from '../session/session-manager'
import type { ConversationActivity } from '../types'

/**
 * Session activity as plain JSON for the conversation reducer. An ACP message whose JSON text is over `limit`
 * bytes becomes a truncation marker with its size, method and id. Used by WebuiLink and ConversationStore, each
 * with its own limit.
 */
export function truncateActivity(activity: SessionActivity['activity'], limit: number): ConversationActivity {
  if (activity.kind !== 'acp') return activity
  const { direction, message } = activity
  const text = JSON.stringify(message)
  const bytes = Buffer.byteLength(text)
  if (bytes <= limit) return { kind: 'acp', direction, message: JSON.parse(text) }
  return { kind: 'acp', direction, message: { truncated: true, bytes, method: 'method' in message ? message.method : null, id: 'id' in message ? message.id : null } }
}
