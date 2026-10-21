import type { ClientSideConnection, RequestError } from '@agentclientprotocol/sdk'
import type { SubagentConfig } from '../types'
import { CockpitError, registerAdapter, SubagentAdapter } from './adapter'
import type { AgentSpec, CommandSpec, SessionMeta } from './adapter'

/** Grok's own delete method; it does not implement ACP session/delete. */
const GROK_DELETE = '_x.ai/session/delete'

/**
 * Grok Build, which speaks ACP itself: the local grok runs as `grok agent --no-leader <args> stdio`.
 * Grok has no ACP modes; its permission mode comes from grok's own config or args.
 */
export class GrokAdapter extends SubagentAdapter {
  protected readonly spec: AgentSpec = { program: 'grok', min_version: [1, 0, 46] }

  protected getCommand(config: SubagentConfig, env: Record<string, string>, program: string): CommandSpec {
    config.mode && this.host.log('grok adapter ignores mode; set the permission mode in grok config or args')
    // --no-leader: one grok process per session, so closing the session ends it
    return { command: program, args: ['agent', '--no-leader', ...config.args, 'stdio'], env }
  }

  /** args already go on the command line. */
  protected argsMeta(_args: string[]): SessionMeta {
    return undefined
  }

  protected onAuthRequired(error: RequestError): CockpitError {
    return new CockpitError('AUTH_REQUIRED', `Grok is not logged in (${error.message}). Run \`grok login\`, or set XAI_API_KEY in the subagent env config.`)
  }

  /** Delete through grok's own method. It removes the session files and grok does not write them back. */
  protected async requestNativeDelete(conn: ClientSideConnection, sessionId: string): Promise<boolean> {
    const { success } = await conn.extMethod(GROK_DELETE, { sessionId })
    if (success !== true) throw new CockpitError('AGENT_ERROR', `grok did not delete session ${sessionId}`)
    return true
  }
}

registerAdapter('grok', GrokAdapter)
