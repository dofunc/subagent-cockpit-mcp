import type { TranscriptParser } from '../transcript'
import { claude } from './claude'
import { codex } from './codex'
import { grok } from './grok'
import { opencode } from './opencode'

/** Parsers by adapter name. antigravity runs through this project's own bridge and sends standard ACP only. */
export const PARSERS: Record<string, TranscriptParser> = { claude, codex, grok, opencode }
