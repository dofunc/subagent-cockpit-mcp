// Shared types for MCP tool params and results. Exported for the mod project.

export type AgentState = 'OPENING' | 'IDLE' | 'RUNNING' | 'ASKING' | 'QUESTIONING' | 'CLOSED'

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'INVALID_STATE'
  | 'SUBAGENT_NOT_FOUND'
  | 'PROFILE_NOT_FOUND'
  | 'SUBAGENT_EXITED'
  | 'SESSION_IN_USE'
  | 'AUTH_REQUIRED'
  | 'RESUME_NOT_SUPPORTED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_VERSION_UNSUPPORTED'
  | 'INVALID_OPTION'
  | 'AGENT_ERROR'

// ── Config ──

export interface SubagentConfig {
  adapter: string
  description: string
  /** Name of the profile this subagent builds on, '' for none. */
  profile: string
  role: string
  model: string
  reasoning_effort: string
  mode: string
  /** Agent program path; '' looks the adapter's program up in PATH. */
  path: string
  /** Extra command line args for the agent program, used when the ACP adapter supports them. */
  args: string[]
  env: Record<string, string>
}

/** Fields a profile may set. */
export type ProfileConfig = Partial<Pick<SubagentConfig, 'role' | 'model' | 'reasoning_effort' | 'mode' | 'path' | 'args' | 'env'>>

export interface AppConfig {
  /** Seconds an IDLE session may stay open before it is closed; 0 never closes. */
  idle: { timeout: number }
  /** Port of the shared webui on 127.0.0.1; 0 turns it off. SUBAGENT_COCKPIT_WEBUI_PORT takes precedence. */
  webui: { port: number }
  profiles: Record<string, ProfileConfig>
  /** As written in config.json; resolveSubagent() applies the profile and defaults. */
  subagents: Record<string, Partial<SubagentConfig>>
}

// ── Tool params ──

export interface OpenParams {
  subagent: string
  cwd: string
  session?: string
  reuse?: boolean
  role?: string
}

export interface SnapshotParams {
  since?: number
  server_id?: string
  ack?: string[]
}

// ── Tool results ──

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface PermissionOptionInfo {
  option_id: string
  name: string
  kind: PermissionOptionKind
}

export interface ApprovalInfo {
  approval_id: string
  tool_call_id: string
  title: string
  kind: string | null
  options: PermissionOptionInfo[]
}

export type PromptStatus = 'done' | 'approval_needed' | 'question_needed' | 'running'

export type TurnOutcome = 'done' | 'cancelled' | 'error'

/** Plain JSON, the shape of an agent's elicitation schema. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

/** A question the agent asks through ACP elicitation (form mode), passed on as sent. */
export interface QuestionInfo {
  question_id: string
  /** Tool call the question belongs to; null when it stands on its own */
  tool_call_id: string | null
  message: string
  /** The agent's form schema, unchanged. Answer with content whose keys and values follow it. */
  requested_schema: JsonObject
}

export type AnswerAction = 'accept' | 'decline' | 'cancel'

/** Field values of an accepted answer, as ACP allows them. */
export type AnswerContent = Record<string, string | number | boolean | string[]>

export interface PromptResult {
  status: PromptStatus
  turn_id?: number
  outcome?: TurnOutcome
  output?: string
  approval?: ApprovalInfo
  question?: QuestionInfo
}

export interface PlanEntryInfo {
  content: string
  priority: string
  status: string
}

export interface UsageInfo {
  used: number
  size: number
  cost: { amount: number; currency: string } | null
}

export interface CommandInfo {
  name: string
  description: string
}

export interface ConfigSelectValue {
  value: string
  name: string
}

export interface ConfigOptionInfo {
  id: string
  name: string
  category: string | null
  type: 'select' | 'boolean'
  current_value: string | boolean
  options: ConfigSelectValue[]
}

/** Current value of each config option, keyed by config id. */
export type ConfigValues = Record<string, string | boolean>

export interface OpenResult extends PromptResult {
  session: string
  reused: boolean
  config_options: ConfigOptionInfo[]
}

export interface SetConfigResult {
  config_options: ConfigOptionInfo[]
}

export interface SubagentInfo {
  name: string
  adapter: string
  description: string
  profile: string
}

export interface SubagentsResult {
  subagents: SubagentInfo[]
}

export interface SessionSummary {
  session: string
  subagent: string
  cwd: string
  role: string
  state: AgentState
  in_use: boolean
  created_at: string
  last_prompt: string
  last_at: string
  /** Title the agent gave the session, '' when none */
  title: string
}

export interface SessionsResult {
  sessions: SessionSummary[]
}

/** Fields shared by `status` and each session of `snapshot`. */
export interface SessionState {
  session: string
  state: AgentState
  cancelling: boolean
  subagent: string
  cwd: string
  approvals: ApprovalInfo[]
  questions: QuestionInfo[]
  waiting: boolean
}

/** Result of `progress`: the agent's latest execution feedback, read on demand. */
export interface ProgressResult {
  plan: PlanEntryInfo[]
  usage: UsageInfo | null
  title: string | null
  commands: CommandInfo[]
}

/** Result of `status`. Config carries current values only; open, set_config and snapshot carry the choices. */
export interface SessionStatus extends SessionState {
  config: ConfigValues
}

export interface CancelResult {
  status: 'cancelling' | 'done'
}

export interface OutputResult {
  turn_id: number | null
  output: string
}

export interface CloseResult {
  closed: string[]
}

export type NativeDeleteResult = 'deleted' | 'archived' | 'unsupported'

export interface DeleteResult {
  session: string
  native: NativeDeleteResult
}

// ── Snapshot ──

export interface ToolCallView {
  tool_call_id: string
  title: string
  kind: string | null
  status: string | null
}

export interface SessionEvent {
  seq: number
  turn_id: number | null
  replay: boolean
  type: string
  text?: string
  tool_call?: ToolCallView
  plan?: PlanEntryInfo[]
}

export interface SessionView {
  turn_id: number | null
  output: string
  tool_calls: ToolCallView[]
}

export interface NotificationItem {
  key: string
  type: 'turn' | 'approval' | 'question'
  turn_id?: number
  outcome?: TurnOutcome
  approval?: ApprovalInfo
  question?: QuestionInfo
}

/** UI clients read it as data, so it carries the feedback too; it never reaches a model's context. */
export interface SessionSnapshot extends SessionState, ProgressResult {
  config_options: ConfigOptionInfo[]
  notifications: NotificationItem[]
  events: SessionEvent[]
  view?: SessionView
}

export interface SnapshotResult {
  server_id: string
  seq: number
  reset: boolean
  sessions: SessionSnapshot[]
}

// ── webui monitor ──

/** A JSON-RPC message exactly as it crossed the ACP connection. */
export interface AcpWireMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: JsonValue
  result?: JsonValue
  error?: { code: number; message: string; data?: JsonValue }
}

/** Stand-in for an ACP message over WEBUI_MESSAGE_LIMIT bytes. */
export interface TruncatedMessage { truncated: true; bytes: number; method: string | null; id: string | number | null }

export type ApprovalResolution = 'approve' | 'allow' | 'reject' | 'cancelled'
export type SessionCloseReason = 'closed' | 'idle' | 'shutdown' | 'exited' | 'deleted'

/** One thing that happened in a session, as the webui receives it. */
export type ConversationActivity =
  | { kind: 'acp'; direction: 'in' | 'out'; message: AcpWireMessage | TruncatedMessage }
  | { kind: 'turn_started'; turn_id: number; internal: boolean }
  | { kind: 'turn_finished'; turn_id: number; outcome: TurnOutcome; error: string | null }
  | { kind: 'approval'; approval_id: string; tool_call_id: string }
  | { kind: 'approval_resolved'; approval_id: string; resolution: ApprovalResolution; option_id: string | null }
  | { kind: 'auto_approved'; tool_call_id: string; option_id: string }
  | { kind: 'question'; question_id: string }
  | { kind: 'question_resolved'; question_id: string; action: AnswerAction }
  | { kind: 'state'; state: AgentState; cancelling: boolean }
  | { kind: 'session_opened'; subagent: string; adapter: string; cwd: string; title: string | null; state: AgentState; reconnected: boolean }
  | { kind: 'session_closed'; reason: SessionCloseReason }

/** MCP server -> webui, one JSON text frame each. */
export type McpToWebui =
  | { type: 'hello'; pid: number; cwd: string; version: string; started_at: number }
  | { type: 'client'; name: string; version: string }
  | { type: 'activity'; session: string; at: number; activity: ConversationActivity }

export interface McpInfo {
  mcp_id: string
  pid: number
  cwd: string
  version: string
  started_at: number
  client: { name: string; version: string } | null
  connected: boolean
}

/** GET /api/ping */
export interface WebuiPingResult { name: string; protocol: number; pid: number; version: string }

export type ConversationItemKind =
  | 'prompt' | 'message' | 'thought' | 'user_message' | 'session_message' | 'compaction'
  | 'tool' | 'plan' | 'approval' | 'question' | 'notice' | 'subagent' | 'error' | 'turn' | 'event' | 'raw'

/** One entry of the conversation view. */
export interface ConversationItem {
  /** Stable key: `tool:<toolCallId>`, `plan:<planId>`, `prompt:<turn_id>`, `turn:<turn_id>`, or `<kind>:<log seq>` */
  id: string
  kind: ConversationItemKind
  at: number
  turn_id: number | null
  /** Fields as received, merged; never interpreted or dropped */
  data: Record<string, JsonValue>
  /** seq of the protocol log entries behind this item, for the raw view */
  log: number[]
}

export interface MessageLogEntry { seq: number; at: number; direction: 'in' | 'out'; message: AcpWireMessage | TruncatedMessage }

/** One session as the webui holds it. Not the MCP `snapshot` SessionView. */
export interface Conversation {
  session: string
  mcp_id: string
  subagent: string
  adapter: string
  cwd: string
  title: string | null
  state: AgentState
  cancelling: boolean
  closed: SessionCloseReason | null
  /** initialize / session/new results and the latest usage, commands, mode and config options */
  info: Record<string, JsonValue>
  items: ConversationItem[]
  log: MessageLogEntry[]
  /**
   * Request key -> item id, so a response lands on its request's item. Each side of an ACP connection
   * numbers its own requests, so the key is `<direction>:<typeof id>:<id>`; a response travels the
   * opposite way of its request. A reconnect opens a new connection that numbers from 0 again, so
   * session_opened clears this map.
   */
  requests: Record<string, string>
  version: number
}

/** webui -> browser over SSE: event name -> data. */
export interface ConversationStreamEvents {
  init: { mcps: McpInfo[]; sessions: Conversation[] }
  mcp_connected: McpInfo
  mcp_updated: McpInfo
  mcp_disconnected: { mcp_id: string }
  activity: { mcp_id: string; session: string; at: number; activity: ConversationActivity }
}
