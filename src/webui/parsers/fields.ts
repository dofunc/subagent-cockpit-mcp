import type { AcpWireMessage, JsonObject, JsonValue } from '../../types'
import type { Parsed } from '../transcript'

/** A field as an object; anything else reads as empty. Parsers keep their own copy so they never import transcript.ts at run time. */
export const obj = (value: JsonValue | undefined): JsonObject => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {})

/** `_auth/status_update` (codex-acp and claude-agent-acp): the login in use goes to the session info. */
export const authStatus = (message: AcpWireMessage): Parsed | undefined =>
  (message.method === '_auth/status_update' ? { info: { auth: obj(message.params).authStatus ?? null } } : undefined)
