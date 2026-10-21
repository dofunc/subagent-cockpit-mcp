import type { RequestError } from '@agentclientprotocol/sdk'
import type * as acp from '@agentclientprotocol/sdk'
import type { NativeDeleteResult, PermissionOptionInfo, SubagentConfig } from '../types'
import { CockpitError, commandOf, registerAdapter, SubagentAdapter } from './adapter'
import type { AgentSpec, AllowRule } from './adapter'

// codex-acp option ids that allow only within the session (src/permissions/option-ids.ts)
const SESSION_ALLOW_IDS = ['allow_for_session', 'allow_permissions_session', 'allow_session']
// The prefix codex proposes for "don't ask again" is only exposed in the option name
const PROPOSED_PREFIX = /start with `([^`]+)`/

const words = (command: string) => command.trim().split(/\s+/)

/**
 * Codex through @agentclientprotocol/codex-acp, bundled as dist/codex-acp.js. The local codex program
 * is passed as CODEX_PATH; mode sets INITIAL_AGENT_MODE. codex-acp takes no command line args.
 */
export class CodexAdapter extends SubagentAdapter {
  protected readonly spec: AgentSpec = { program: 'codex', min_version: [0, 160, 1], path_env: 'CODEX_PATH', entry: 'codex-acp.js' }

  protected buildEnv(config: SubagentConfig): Record<string, string> {
    const env = super.buildEnv(config)
    config.mode && (env.INITIAL_AGENT_MODE = config.mode)
    return env
  }

  protected onAuthRequired(error: RequestError): CockpitError {
    return new CockpitError('AUTH_REQUIRED', `Codex is not logged in (${error.message}). Run \`codex login\`, or set credentials in the subagent env config.`)
  }

  protected nativeDeleteResult(): NativeDeleteResult {
    return 'archived'
  }

  /** File edits and permission requests come with codex's own session-scoped allow option. */
  protected sessionAllowOption(options: PermissionOptionInfo[]): PermissionOptionInfo | undefined {
    return options.find(o => SESSION_ALLOW_IDS.includes(o.option_id))
  }

  /**
   * Shell commands only offer a persistent prefix rule (accept_execpolicy_amendment), written to
   * CODEX_HOME/rules. Keep the same prefix as a session rule instead: the prefix codex proposed,
   * or the whole command when none is offered. Matching compares whitespace-separated words.
   */
  protected allowRule(request: acp.RequestPermissionRequest): AllowRule {
    const command = commandOf(request.toolCall)
    if (request.toolCall.kind !== 'execute' || !command) return super.allowRule(request)
    const proposed = request.options.map(o => PROPOSED_PREFIX.exec(o.name)?.[1]).find(p => p !== undefined)
    const prefix = words(proposed ?? command)
    return {
      matches: ({ toolCall }) => {
        const next = commandOf(toolCall)
        const nextWords = next ? words(next) : []
        return toolCall.kind === 'execute' && prefix.every((w, i) => nextWords[i] === w)
      },
    }
  }
}

registerAdapter('codex', CodexAdapter)
