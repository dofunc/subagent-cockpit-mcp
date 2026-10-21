import type { RequestError } from '@agentclientprotocol/sdk'
import type { SubagentConfig } from '../types'
import { CockpitError, registerAdapter, SubagentAdapter } from './adapter'
import type { AgentSpec, NativeSessionManager, SessionMeta } from './adapter'

/** Agent SDK extraArgs: `--key value`, or `--key` alone for null. */
type ExtraArgs = Record<string, string | null>

const LONG_FLAG = /^--([^=]+)(?:=(.*))?$/

/**
 * Claude Code through @agentclientprotocol/claude-agent-acp, bundled as dist/claude-agent-acp.js.
 * The local claude program is passed as CLAUDE_CODE_EXECUTABLE; args travel as SDK extraArgs in
 * `_meta.claudeCode.options`. Mode has no env switch, so it is set as a config option after setup.
 */
export class ClaudeAdapter extends SubagentAdapter {
  protected readonly spec: AgentSpec = { program: 'claude', min_version: [2, 1, 292], path_env: 'CLAUDE_CODE_EXECUTABLE', entry: 'claude-agent-acp.js' }

  /** Mode goes last: switching the model can invalidate the `auto` mode. */
  protected initialConfig(config: SubagentConfig): Array<[string, string]> {
    return [['model', config.model], ['effort', config.reasoning_effort], ['mode', config.mode]]
  }

  protected argsMeta(args: string[]): SessionMeta {
    const extraArgs = this.toExtraArgs(args)
    return Object.keys(extraArgs).length > 0 ? { claudeCode: { options: { extraArgs } } } : undefined
  }

  /**
   * claude writes the last prompt, title and cost back into the transcript as it shuts down, which
   * would recreate the file after a session/delete on the live connection. So an open session is
   * closed first, and deleted through a temporary agent once its process has exited.
   */
  getNativeSessionManager(): NativeSessionManager {
    const base = super.getNativeSessionManager()
    return {
      delete: async session => {
        if (!this.started) return base.delete(session)
        try {
          await this.settleForDelete()
        } finally {
          await this.close()
        }
        return this.deleteThrough(session.temporary(), session)
      },
    }
  }

  protected onAuthRequired(error: RequestError): CockpitError {
    return new CockpitError('AUTH_REQUIRED', `Claude Code is not logged in (${error.message}). Run \`claude\` in a terminal and log in, or set credentials in the subagent env config.`)
  }

  /**
   * ['--a', 'x', '--b', '--c=y'] -> { a: 'x', b: null, c: 'y' }. A value fills the flag right before it.
   * Short flags and values with no open flag cannot be mapped reliably; they are logged and skipped.
   */
  private toExtraArgs(args: string[]): ExtraArgs {
    const { extra } = args.reduce<{ extra: ExtraArgs; open?: string }>(({ extra, open }, token) => {
      const long = LONG_FLAG.exec(token)
      if (long) {
        const [, key, value] = long
        return value === undefined ? { extra: { ...extra, [key]: null }, open: key } : { extra: { ...extra, [key]: value } }
      }
      if (open !== undefined && !token.startsWith('-')) return { extra: { ...extra, [open]: token } }
      this.host.log(`claude adapter ignores arg ${token}`)
      return { extra }
    }, { extra: {} })
    return extra
  }
}

registerAdapter('claude', ClaudeAdapter)
