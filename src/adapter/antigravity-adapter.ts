import type { RequestError } from '@agentclientprotocol/sdk'
import type { SubagentConfig } from '../types'
import { CockpitError, registerAdapter, SubagentAdapter } from './adapter'
import type { AgentSpec, CommandSpec, SessionMeta } from './adapter'

/**
 * Google Antigravity through the bundled bridge dist/agy-acp.js, which drives `agy -p` in stream-json mode.
 * The local agy is passed as AGY_PATH; args follow the bridge and reach the agy command line as given.
 * agy's headless mode cannot ask for approvals or questions: tools that need a permission are denied by agy.
 */
export class AntigravityAdapter extends SubagentAdapter {
  protected readonly spec: AgentSpec = { program: 'agy', min_version: [1, 4, 2], path_env: 'AGY_PATH', entry: 'agy-acp.js' }

  protected getCommand(config: SubagentConfig, env: Record<string, string>, program: string): CommandSpec {
    const command = super.getCommand(config, env, program)
    return { ...command, args: [...command.args, ...config.args] }
  }

  protected initialConfig(config: SubagentConfig): Array<[string, string]> {
    return [['model', config.model], ['reasoning_effort', config.reasoning_effort], ['mode', config.mode]]
  }

  /** args already go on the agy command line. */
  protected argsMeta(_args: string[]): SessionMeta {
    return undefined
  }

  protected onAuthRequired(error: RequestError): CockpitError {
    return new CockpitError('AUTH_REQUIRED', `Antigravity is not logged in (${error.message}). Run \`agy\` in a terminal and sign in.`)
  }
}

registerAdapter('antigravity', AntigravityAdapter)
