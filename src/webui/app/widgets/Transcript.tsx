import type { CSSProperties, ReactNode } from 'react'
import { Alert, Flex, Tag, theme, Typography } from 'antd'
import { ApartmentOutlined, CloseCircleOutlined, ExclamationCircleOutlined, FileTextOutlined, InfoCircleOutlined, ScissorOutlined, SettingOutlined, ShrinkOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Bubble, Think } from '@ant-design/x'
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

/**
 * Percent of the prompt read from the cache, or undefined when the agent reports no cache reads. ACP keeps
 * cache reads and writes out of inputTokens, so the prompt is all three together.
 */
function cacheRate(usage: JsonObject): number | undefined {
  const [input, read, write] = [usage.inputTokens, usage.cachedReadTokens, usage.cachedWriteTokens].map(v => (typeof v === 'number' ? v : 0))
  const prompt = input + read + write
  return typeof usage.cachedReadTokens === 'number' && prompt > 0 ? Math.round((read / prompt) * 100) : undefined
}

/** Divider text for a finished turn: outcome, stop reason, tokens, cache hit rate, context at its end and error. */
function turnSummary({ turn_id, data }: ConversationItem, t: Translate): string {
  const usage = obj(data.usage)
  const context = obj(data.context)
  const rate = cacheRate(usage)
  return [
    t('turn', { id: turn_id ?? '?' }),
    text(data.outcome),
    text(data.stopReason),
    usage.totalTokens === undefined ? '' : t('tokens', { count: tokenCount(Number(usage.totalTokens)) }),
    rate === undefined ? '' : t('cacheHit', { rate: String(rate) }),
    context.size === undefined ? '' : t('turnContext', { used: tokenCount(Number(context.used)), size: tokenCount(Number(context.size)) }),
    text(data.error),
  ].filter(Boolean).join(' · ')
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
  return (
    <Compact>
      <Bubble.List style={{ height: '100%' }} role={ROLES} items={items} />
    </Compact>
  )
}
