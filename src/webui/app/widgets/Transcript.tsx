import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, UIEvent } from 'react'
import { Alert, Button, Divider, Flex, Tag, theme, Typography } from 'antd'
import { ApartmentOutlined, ArrowDownOutlined, CloseCircleOutlined, ExclamationCircleOutlined, FileTextOutlined, InfoCircleOutlined, ScissorOutlined, SettingOutlined, ShrinkOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Bubble, Think } from '@ant-design/x'
import type { GetRef } from 'antd'
import type { BubbleItemType, BubbleListProps } from '@ant-design/x'
import type { ConversationItem, Conversation, JsonObject } from '../../../types'
import { isObject } from '../../transcript'
import type { Translate } from '../i18n'
import { list, obj, text } from '../json'
import { usePreferences } from '../preferences'
import ApprovalCard from './ApprovalCard'
import Compact from './Compact'
import ContentBlockView from './ContentBlockView'
import KeyValues from './KeyValues'
import PlanCard from './PlanCard'
import { DirectionTag } from './ProtocolLog'
import QuestionCard from './QuestionCard'
import ToolCallCard from './ToolCallCard'

const ROLES: BubbleListProps['role'] = {
  user: { placement: 'end' },
  ai: { placement: 'start', variant: 'outlined' },
}

/** Cards take the full row; only the dialogue itself (prompts, replies) shrinks to its text. */
const FULL_WIDTH = { body: { width: '100%' }, content: { width: '100%' } }

/** A system bubble centers its content in a row; a column stretches cards and event lines to the full width instead. */
const SYSTEM_WIDTH: { body: CSSProperties; content: CSSProperties } = { body: { width: '100%' }, content: { width: '100%', flexDirection: 'column', alignItems: 'stretch' } }

/** How far above the bottom, in px, the list counts as scrolled up */
const AWAY_FROM_BOTTOM = 48

/** Fields a raw item's header line already shows */
const HEADER_FIELDS = new Set(['direction', 'jsonrpc', 'method', 'id', 'sessionUpdate', 'sessionId'])

function Blocks({ item, streaming }: { item: ConversationItem; streaming: boolean }) {
  const blocks = list(item.data.content ?? item.data.prompt)
  return <Flex vertical gap={8}>{blocks.map((block, index) => <ContentBlockView key={index} block={block} streaming={streaming && index === blocks.length - 1} />)}</Flex>
}

/** A token count, from a thousand on in K and from a million on in M with one decimal: 8856 -> 8.9K, 8000 -> 8K. */
function tokenCount(count: number): string {
  const [divisor, unit] = count >= 1e6 ? [1e6, 'M'] : count >= 1e3 ? [1e3, 'K'] : [1, '']
  return `${(count / divisor).toFixed(unit ? 1 : 0).replace(/\.0$/, '')}${unit}`
}

/** A turn's length: 8.2s under a minute, 1m 23s under an hour, then 1h 2m. */
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  if (ms < 3_600_000) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/**
 * Percent of the prompt read from the cache, or undefined when the agent reports no cache reads. ACP keeps
 * cache reads and writes out of inputTokens, so the prompt is all three together.
 */
function cacheRate(usage: JsonObject): number | undefined {
  const [input, read, write] = [usage.inputTokens, usage.cachedReadTokens, usage.cachedWriteTokens].map(v => (typeof v === 'number' ? v : 0))
  const prompt = input + read + write
  return typeof usage.cachedReadTokens === 'number' && prompt > 0 ? Math.round((read / prompt) * 100) : undefined
}

/**
 * Divider text for a finished turn: outcome (and why, for a turn the close ended), stop reason, duration, tokens,
 * cache hit rate, context at its end and error.
 */
function turnSummary({ turn_id, data }: ConversationItem, t: Translate): string {
  const usage = obj(data.usage)
  const context = obj(data.context)
  const rate = cacheRate(usage)
  return [
    t('turn', { id: turn_id ?? '?' }),
    text(data.outcome),
    text(data.reason),
    text(data.stopReason),
    typeof data.duration_ms === 'number' ? duration(data.duration_ms) : '',
    usage.totalTokens === undefined ? '' : t('tokens', { count: tokenCount(Number(usage.totalTokens)) }),
    rate === undefined ? '' : t('cacheHit', { rate: String(rate) }),
    context.size === undefined ? '' : t('turnContext', { used: tokenCount(Number(context.used)), size: tokenCount(Number(context.size)) }),
    text(data.error),
  ].filter(Boolean).join(' · ')
}

interface RunningTurnProps {
  prompt: ConversationItem
  /** The divider of the turn before it, if any */
  previous: ConversationItem | undefined
  /** The latest usage_update */
  live: JsonObject
}

/**
 * The running turn's line, in the divider's order: turn, running, time so far (ticking each second), tokens, cache
 * and context. Tokens and cache only come with a turn's result, so they are the previous turn's; the context is the
 * latest usage_update's, else the previous turn's too.
 */
function RunningTurn({ prompt, previous, live }: RunningTurnProps) {
  const { t } = usePreferences()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const usage = obj(previous?.data.usage)
  const rate = cacheRate(usage)
  const context = typeof live.size === 'number' && live.size > 0 ? live : obj(previous?.data.context)
  const line = [
    t('turn', { id: prompt.turn_id ?? '?' }),
    t('turnRunning'),
    duration(Math.floor(Math.max(0, now - prompt.at) / 1000) * 1000),
    usage.totalTokens === undefined || usage.totalTokens === null ? '' : t('tokens', { count: tokenCount(Number(usage.totalTokens)) }),
    rate === undefined ? '' : t('cacheHit', { rate: String(rate) }),
    context.size === undefined ? '' : t('turnContext', { used: tokenCount(Number(context.used)), size: tokenCount(Number(context.size)) }),
  ].filter(Boolean).join(' · ')
  // Drawn like the finished turn's divider; markdown.css colors the text and sweeps a light through it
  return (
    <Divider style={{ margin: '12px 0' }}>
      <Flex component="span" className="cockpit-turn-line-sweep">{line}</Flex>
    </Divider>
  )
}

/**
 * The running turn, pinned under the list; gone once the turn ends and its divider shows the totals. The latest
 * prompt with no divider after it is the running turn; a closed session always ends its turn with a divider.
 */
function TurnLine({ session }: { session: Conversation }) {
  const latest = session.items.findLast(item => item.kind === 'prompt' || item.kind === 'turn')
  if (latest?.kind !== 'prompt' || session.closed !== null) return null
  const previous = session.items.findLast(item => item.kind === 'turn')
  return <RunningTurn prompt={latest} previous={previous} live={obj(session.info.usage)} />
}

interface EventLineProps {
  icon: ReactNode
  title: string
  /** Shown after the title in secondary text; empty entries are skipped */
  details: string[]
}

/** A short event on one line, as Claude Code's terminal prints them: an icon, the title, then the details. */
function EventLine({ icon, title, details }: EventLineProps) {
  const rest = details.filter(Boolean)
  return (
    <Flex gap={8} align="baseline">
      {icon}
      <Typography.Text>
        {title}
        {rest.length > 0 && <Typography.Text type="secondary">{` · ${rest.join(' · ')}`}</Typography.Text>}
      </Typography.Text>
    </Flex>
  )
}

/**
 * Items that are not part of the dialogue itself, shown as system bubbles. Notices, subagent updates,
 * compaction and truncation are one-line events; approvals, questions and errors are cards.
 */
function SystemContent({ item }: { item: ConversationItem }) {
  const { t } = usePreferences()
  const { token } = theme.useToken()
  const { data } = item
  switch (item.kind) {
    case 'approval':
      return <ApprovalCard item={item} />
    case 'question':
      return <QuestionCard item={item} />
    case 'notice': {
      const severity = text(data.severity)
      const icon = severity === 'error'
        ? <CloseCircleOutlined style={{ color: token.colorError }} />
        : severity === 'warning'
          ? <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
          : <InfoCircleOutlined style={{ color: token.colorInfo }} />
      return <EventLine icon={icon} title={text(data.title)} details={[text(data.description)]} />
    }
    case 'subagent':
      return (
        <EventLine
          icon={<ApartmentOutlined style={{ color: token.colorInfo }} />}
          title={t('subagentUpdate', { name: text(data.title) || text(data.sessionId) })}
          details={[text(obj(data.state).state), text(data.description)]}
        />
      )
    case 'compaction':
      return (
        <EventLine
          icon={data.status === 'failed' ? <CloseCircleOutlined style={{ color: token.colorError }} /> : <ShrinkOutlined style={{ color: token.colorInfo }} />}
          title={t('compaction', { id: text(data.compactionId), status: text(data.status) })}
          details={[...list(data.summary).map(block => text(obj(block).text)), text(data.error)]}
        />
      )
    case 'event':
      return <PlatformEvent data={data} />
    case 'error': {
      const error = obj(data.error)
      return (
        <Alert
          type="error"
          title={t('requestFailed', { method: text(data.method) || t('request'), message: text(error.message) })}
          description={(
            <Flex vertical gap={4}>
              <Typography.Text type="secondary">{t('errorDetail', { code: text(error.code), id: text(data.id) })}</Typography.Text>
              {error.data !== undefined && <KeyValues value={error.data} />}
            </Flex>
          )}
        />
      )
    }
    default:
      return data.truncated === true
        ? (
          <EventLine
            icon={<ScissorOutlined style={{ color: token.colorWarning }} />}
            title={t('truncated', { bytes: Number(data.bytes).toLocaleString() })}
            details={[`${text(data.method) || t('response')} · id ${text(data.id) || '-'}`]}
          />
        )
        : <RawContent data={data} />
  }
}

/** An `event` item, made by a platform parser or from a config change this server sent, as one line. */
function PlatformEvent({ data }: { data: ConversationItem['data'] }) {
  const { t } = usePreferences()
  const { token } = theme.useToken()
  switch (data.event) {
    case 'hook': {
      const runs = list(data.runs).map(obj).map(run => {
        const status = obj(run.status)
        return [text(run.name), text(status.status), status.elapsed_ms === undefined ? '' : `${text(status.elapsed_ms)} ms`].filter(Boolean).join(' ')
      })
      return <EventLine icon={<ThunderboltOutlined style={{ color: token.colorInfo }} />} title={t('hook', { name: text(data.name) })} details={runs} />
    }
    case 'turn_summary':
    case 'session_summary':
      return <EventLine icon={<FileTextOutlined style={{ color: token.colorInfo }} />} title={t(data.event === 'turn_summary' ? 'turnSummary' : 'sessionSummary')} details={[text(data.text)]} />
    case 'config':
      return <EventLine icon={<SettingOutlined style={{ color: token.colorTextTertiary }} />} title={t('configSet', { id: text(data.configId), value: text(data.value) })} details={[]} />
    default:
      return <EventLine icon={<InfoCircleOutlined style={{ color: token.colorInfo }} />} title={text(data.event)} details={[]} />
  }
}

/**
 * A message or update the page has no view for: direction and method on one line, then the params, the
 * result or the update's own fields as a key/value list. The full message is on the protocol log tab.
 */
function RawContent({ data }: { data: ConversationItem['data'] }) {
  const { t } = usePreferences()
  const payload = data.params ?? data.result ?? data
  const body = isObject(payload) ? Object.fromEntries(Object.entries(payload).filter(([key]) => !HEADER_FIELDS.has(key))) : payload
  return (
    <Flex vertical gap={4}>
      <Flex gap={6} align="center">
        <DirectionTag direction={data.direction === 'out' ? 'out' : 'in'} />
        <Typography.Text code>{text(data.method) || text(data.sessionUpdate) || `${t('response')} ${text(data.id)}`}</Typography.Text>
      </Flex>
      {!(isObject(body) && Object.keys(body).length === 0) && <KeyValues value={body} />}
    </Flex>
  )
}

/** What a dialogue bubble is. */
function kindTag({ kind, data }: ConversationItem, t: Translate) {
  if (kind === 'prompt') return <Tag bordered={false}>{t(data.internal === true ? 'rolePrompt' : 'prompt')}</Tag>
  if (kind === 'message') return <Tag bordered={false}>{t('reply')}</Tag>
  if (kind === 'user_message') return <Tag bordered={false}>{t('replayedUserMessage')}</Tag>
  if (kind === 'compaction') return <Tag bordered={false}>{t('compactionSummary')}</Tag>
  if (kind === 'session_message') return <Tag bordered={false}>{t('sessionMessage', { from: text(data.senderSessionId) || '?', to: text(data.recipientSessionId) || '?' })}</Tag>
  return undefined
}

/** Header tags of a bubble: what it is, and the child session it came from (an OpenCode subagent, set by its parser). */
function header(item: ConversationItem, t: Translate) {
  const child = obj(item.data.child_session)
  if (child.id === undefined) return kindTag(item, t)
  return (
    <Flex gap={4}>
      {kindTag(item, t)}
      <Tag bordered={false} color="purple">{t('childSession', { title: text(child.title) || text(child.id) })}</Tag>
    </Flex>
  )
}

function toBubble(session: Conversation, item: ConversationItem, last: boolean, t: Translate): BubbleItemType {
  const streaming = last && session.state === 'RUNNING' && session.closed === null
  // The JSON-RPC messages behind each item live on the protocol log tab
  const base = { key: item.id, header: header(item, t) }
  const card = { ...base, styles: FULL_WIDTH }
  switch (item.kind) {
    case 'turn':
      return { key: item.id, role: 'divider', content: turnSummary(item, t) }
    case 'prompt':
    case 'user_message':
      return { ...base, role: 'user', content: <Blocks item={item} streaming={false} /> }
    case 'message':
    case 'session_message':
      return { ...base, role: 'ai', content: <Blocks item={item} streaming={streaming} /> }
    case 'thought':
      return { ...card, role: 'ai', content: <Think title={t('thinking')} loading={streaming} defaultExpanded><Blocks item={item} streaming={streaming} /></Think> }
    case 'tool':
      // The Collapse draws its own frame
      return { ...card, role: 'ai', variant: 'borderless', content: <ToolCallCard item={item} /> }
    case 'plan':
      return { ...card, role: 'ai', content: <PlanCard item={item} /> }
    default:
      return item.kind === 'compaction' && item.data.sessionUpdate === 'compaction_summary_chunk'
        ? { ...card, role: 'ai', content: <Blocks item={item} streaming={streaming} /> }
        : { key: item.id, role: 'system', styles: SYSTEM_WIDTH, content: <SystemContent item={item} /> }
  }
}

export default function Transcript({ session }: { session: Conversation }) {
  const { t } = usePreferences()
  // turn_started opens the prompt item just before session/prompt fills it; an empty bubble would flash
  const shown = session.items.filter(item => item.kind !== 'prompt' || item.data.prompt !== undefined)
  const items = shown.map((item, index) => toBubble(session, item, index === shown.length - 1, t))
  // @ant-design/x does not export BubbleListRef from its root
  const listRef = useRef<GetRef<typeof Bubble.List>>(null)
  const [away, setAway] = useState(false)
  useEffect(() => setAway(false), [session.mcp_id, session.session])

  // The list scrolls in reverse (autoScroll), so scrollTop is 0 at the bottom and negative above it
  const handleScroll = (event: UIEvent<HTMLDivElement>) => setAway(Math.abs(event.currentTarget.scrollTop) > AWAY_FROM_BOTTOM)
  const handleBottom = () => listRef.current?.scrollTo({ top: 'bottom', behavior: 'smooth' })

  // The tab's font is a CSS variable (markdown.css); antd components take it as their font token
  return (
    <Compact font="var(--cockpit-conversation-font)">
      <Flex vertical className="cockpit-conversation" style={{ height: '100%' }}>
        <Flex vertical style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Bubble.List ref={listRef} style={{ height: '100%' }} role={ROLES} items={items} onScroll={handleScroll} />
          {away && (
            <Button
              shape="round"
              icon={<ArrowDownOutlined />}
              style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 1 }}
              onClick={handleBottom}
            >
              {t('backToBottom')}
            </Button>
          )}
        </Flex>
        <TurnLine session={session} />
      </Flex>
    </Compact>
  )
}
