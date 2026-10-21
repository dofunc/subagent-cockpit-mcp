import type { TranscriptParser } from '../transcript'
import { authStatus, obj } from './fields'

/** claude-agent-acp names the Claude Code tool behind each tool call in `_meta.claudeCode.toolName`. */
export const claude: TranscriptParser = {
  update(update) {
    const name = obj(obj(update._meta).claudeCode).toolName
    const tool = update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
    return tool && typeof name === 'string' ? { update: { ...update, tool_name: name } } : undefined
  },
  message: authStatus,
}
