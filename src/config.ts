import { CockpitError } from './adapter/adapter'
import type { Host } from './host/host'
import type { AppConfig, JsonValue, ProfileConfig, SubagentConfig } from './types'

type ScalarField = 'role' | 'model' | 'reasoning_effort' | 'mode' | 'path'

const SUBAGENT_DEFAULTS: SubagentConfig = {
  adapter: 'codex',
  description: '',
  profile: '',
  role: 'You are a helpful assistant.',
  model: '',
  reasoning_effort: '',
  mode: '',
  path: '',
  args: [],
  env: {},
}

/** 1 MB per ACP message and 5000 messages per session, the same for the webui and snapshot */
const LIMITS = { truncate_message_size: 1_048_576, max_message_count: 5000 }

export const DEFAULT_CONFIG: AppConfig = {
  idle: { timeout: 0 },
  webui: { port: 7200, ...LIMITS },
  snapshot: { ...LIMITS },
  profiles: {},
  subagents: {
    codex: { ...SUBAGENT_DEFAULTS, adapter: 'codex', description: 'OpenAI Codex' },
    claude: { ...SUBAGENT_DEFAULTS, adapter: 'claude', description: 'Claude Code' },
    grok: { ...SUBAGENT_DEFAULTS, adapter: 'grok', description: 'Grok Build' },
    opencode: { ...SUBAGENT_DEFAULTS, adapter: 'opencode', description: 'OpenCode' },
    antigravity: { ...SUBAGENT_DEFAULTS, adapter: 'antigravity', description: 'Google Antigravity' },
    pi: { ...SUBAGENT_DEFAULTS, adapter: 'pi', description: 'Pi' },
  },
}

/** Message limits as written, checked by loadConfig */
type RawLimits = Partial<Record<keyof typeof LIMITS, JsonValue>>

/** An entry as written in config.json: env values may be any JSON value. */
type RawEntry<T> = Omit<T, 'env'> & { env?: Record<string, JsonValue> }

interface RawConfig {
  idle?: Partial<AppConfig['idle']>
  webui?: { port?: number } & RawLimits
  snapshot?: RawLimits
  profiles?: Record<string, RawEntry<ProfileConfig>>
  subagents?: Record<string, RawEntry<Partial<SubagentConfig>>>
}

/** Home dir: SUBAGENT_COCKPIT_HOME, else ~/.subagent-cockpit. */
export function resolveHome(host: Host): string {
  return host.env.get('SUBAGENT_COCKPIT_HOME') || host.store.join(host.env.homeDir(), '.subagent-cockpit')
}

/** Replace ${VAR} in every string of the value with the host env value. Undefined variables become ''. */
function fillRefs(host: Host, value: JsonValue): JsonValue {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, name: string) => host.env.get(name) ?? '')
  if (Array.isArray(value)) return value.map(v => fillRefs(host, v))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillRefs(host, v)]))
  return value
}

/**
 * The env value an agent gets: strings as written, objects and arrays as JSON text, numbers and booleans as text,
 * null as '' (which then means "delete"). ${VAR} is filled before an object becomes JSON, so a filled-in quote
 * cannot break the JSON.
 */
function envValue(host: Host, value: JsonValue): string {
  const filled = fillRefs(host, value)
  if (filled === null) return ''
  return typeof filled === 'object' ? JSON.stringify(filled) : String(filled)
}

/** Resolve the env of every entry to plain strings. */
function withEnvRefs<E extends { env?: Record<string, JsonValue> }>(host: Host, entries: Record<string, E>): Record<string, Omit<E, 'env'> & { env?: Record<string, string> }> {
  return Object.fromEntries(Object.entries(entries).map(([name, { env, ...rest }]) => [
    name,
    { ...rest, ...(env ? { env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, envValue(host, v)])) } : {}) },
  ]))
}

/** A size or count from config.json: the default when missing, else a positive safe integer. Throws otherwise. */
function positiveInt(value: JsonValue | undefined, path: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new Error(`Invalid config: ${path} must be a positive integer, got ${JSON.stringify(value)}`)
}

/** Both limits of one section; `section` names it in errors. */
function limits(raw: RawLimits | undefined, section: string): typeof LIMITS {
  return {
    truncate_message_size: positiveInt(raw?.truncate_message_size, `${section}.truncate_message_size`, LIMITS.truncate_message_size),
    max_message_count: positiveInt(raw?.max_message_count, `${section}.max_message_count`, LIMITS.max_message_count),
  }
}

/**
 * Load <home>/config.json, creating it with defaults on first run. The first file leaves the message limits
 * out to stay short; they take their defaults. Entries are kept as written (env values resolved to strings);
 * resolveSubagent() applies profiles and defaults. Unknown fields are ignored. Throws on a limit that is not a
 * positive integer.
 */
export async function loadConfig(host: Host, home: string): Promise<AppConfig> {
  const path = host.store.join(home, 'config.json')
  if (!await host.store.exists(path)) {
    const { idle, webui, profiles, subagents } = DEFAULT_CONFIG
    await host.store.mkdir(home)
    await host.store.writeText(path, `${JSON.stringify({ idle, webui: { port: webui.port }, profiles, subagents }, null, 2)}\n`)
    host.log(`Created default config: ${path}`)
  }
  const raw: RawConfig = JSON.parse(await host.store.readText(path))
  return {
    idle: { timeout: raw.idle?.timeout ?? DEFAULT_CONFIG.idle.timeout },
    webui: { port: raw.webui?.port ?? DEFAULT_CONFIG.webui.port, ...limits(raw.webui, 'webui') },
    snapshot: limits(raw.snapshot, 'snapshot'),
    profiles: withEnvRefs(host, raw.profiles ?? DEFAULT_CONFIG.profiles),
    subagents: withEnvRefs(host, raw.subagents ?? DEFAULT_CONFIG.subagents),
  }
}

/** Split args into groups led by a --flag; tokens before the first flag form the '' group. */
function argGroups(args: string[]): Array<[string, string[]]> {
  return args.reduce<Array<[string, string[]]>>((groups, token) => {
    const flag = /^--([^=]+)/.exec(token)?.[1]
    const last = groups.at(-1)
    if (flag !== undefined || !last) return [...groups, [flag ?? '', [token]]]
    return [...groups.slice(0, -1), [last[0], [...last[1], token]]]
  }, [])
}

/** Profile args with every group whose flag also appears in the subagent args replaced by the subagent's. */
export function mergeArgs(base: string[], over: string[]): string[] {
  const overGroups = argGroups(over)
  const replaced = new Set(overGroups.map(([flag]) => flag))
  return [...argGroups(base).filter(([flag]) => !replaced.has(flag)), ...overGroups].flatMap(([, tokens]) => tokens)
}

/**
 * Effective config of one subagent: defaults <- profile <- subagent. Non-empty values win; env merges by
 * name (an empty value still deletes later in buildEnv); args merge by --flag.
 * Throws SUBAGENT_NOT_FOUND / PROFILE_NOT_FOUND.
 */
export function resolveSubagent(config: AppConfig, name: string): SubagentConfig {
  // Own keys only: inherited names such as `constructor` or `__proto__` are not configured entries
  const sub = Object.hasOwn(config.subagents, name) ? config.subagents[name] : undefined
  if (!sub) throw new CockpitError('SUBAGENT_NOT_FOUND', `Unknown subagent: ${name}`)
  const profile = !sub.profile ? {} : Object.hasOwn(config.profiles, sub.profile) ? config.profiles[sub.profile] : undefined
  if (!profile) throw new CockpitError('PROFILE_NOT_FOUND', `Subagent ${name} uses unknown profile: ${sub.profile}`)
  const pick = (key: ScalarField) => sub[key] || profile[key] || SUBAGENT_DEFAULTS[key]
  return {
    adapter: sub.adapter || SUBAGENT_DEFAULTS.adapter,
    description: sub.description ?? '',
    profile: sub.profile ?? '',
    role: pick('role'),
    model: pick('model'),
    reasoning_effort: pick('reasoning_effort'),
    mode: pick('mode'),
    path: pick('path'),
    args: mergeArgs(profile.args ?? [], sub.args ?? []),
    env: { ...profile.env, ...sub.env },
  }
}
