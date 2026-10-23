import type { RequestError } from '@agentclientprotocol/sdk'
import type { SubagentConfig } from '../types'
import { CockpitError, registerAdapter, SubagentAdapter } from './adapter'
import type { AgentSpec, CommandSpec, SessionMeta } from './adapter'

/**
 * Pi through the bundled bridge dist/pi-acp.js, which drives `pi --mode rpc`. The local pi is passed as PI_PATH;
 * args follow the bridge and reach the pi command line as given. Pi never asks for approvals or questions.
 */
export class PiAdapter extends SubagentAdapter {
  protected readonly spec: AgentSpec = { program: 'pi', min_version: [1, 4, 0], path_env: 'PI_PATH', entry: 'pi-acp.js' }

  protected getCommand(config: SubagentConfig, env: Record<string, string>, program: string): CommandSpec {
    config.mode && this.host.log('pi adapter ignores mode; pi has no modes, limit its tools with args such as --tools')
    const command = super.getCommand(config, env, program)
    return { ...command, args: [...command.args, ...config.args] }
  }

  protected initialConfig(config: SubagentConfig): Array<[string, string]> {
    return [['model', config.model], ['reasoning_effort', config.reasoning_effort]]
  }

  /** args already go on the pi command line. */
  protected argsMeta(_args: string[]): SessionMeta {
    return undefined
  }

  protected onAuthRequired(error: RequestError): CockpitError {
    return new CockpitError('AUTH_REQUIRED', `Pi has no API key for the selected model (${error.message}). Run \`pi\` in a terminal and use /login, or set the provider's key in the subagent env config.`)
  }
}

registerAdapter('pi', PiAdapter)
