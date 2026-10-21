import type { RequestError } from '@agentclientprotocol/sdk'
import type { SubagentConfig } from '../types'
import { CockpitError, registerAdapter, SubagentAdapter } from './adapter'
import type { AgentSpec, CommandSpec, SessionMeta } from './adapter'

/**
 * OpenCode V2, which speaks ACP itself: the local opencode runs as `opencode acp <args>`, each process with its own
 * private server. Model, effort and mode (OpenCode's agent, build or plan) are ACP config options.
 */
export class OpenCodeAdapter extends SubagentAdapter {
  protected readonly spec: AgentSpec = { program: 'opencode', min_version: [2, 0, 30] }

  protected getCommand(config: SubagentConfig, env: Record<string, string>, program: string): CommandSpec {
    return { command: program, args: ['acp', ...config.args], env }
  }

  protected initialConfig(config: SubagentConfig): Array<[string, string]> {
    return [['model', config.model], ['effort', config.reasoning_effort], ['mode', config.mode]]
  }

  /** args already go on the command line. */
  protected argsMeta(_args: string[]): SessionMeta {
    return undefined
  }

  protected onAuthRequired(error: RequestError): CockpitError {
    return new CockpitError('AUTH_REQUIRED', `OpenCode has no credentials for the model (${error.message}). Run \`opencode auth login\`, or set up a provider through OPENCODE_CONFIG in the subagent env config.`)
  }
}

registerAdapter('opencode', OpenCodeAdapter)
