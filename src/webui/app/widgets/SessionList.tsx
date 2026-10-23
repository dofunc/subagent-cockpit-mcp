import { useState } from 'react'
import { Avatar, Badge, Flex, Menu, theme, Tooltip, Typography } from 'antd'
import type { BadgeProps, GlobalToken, MenuProps } from 'antd'
import { DisconnectOutlined } from '@ant-design/icons'
import type { AgentState, McpInfo, Conversation, SessionCloseReason } from '../../../types'
import type { MessageKey, Translate } from '../i18n'
import { list, obj, text } from '../json'
import { usePreferences } from '../preferences'
import antigravityIcon from '../icons/antigravity.svg'
import claudeIcon from '../icons/claude.svg'
import codexDarkIcon from '../icons/codex-dark.svg'
import codexIcon from '../icons/codex.svg'
import grokDarkIcon from '../icons/grok-dark.svg'
import grokIcon from '../icons/grok.svg'
import opencodeDarkIcon from '../icons/opencode-dark.svg'
import opencodeIcon from '../icons/opencode.svg'
import piIcon from '../icons/pi.svg'

export const STATE_BADGES: Record<AgentState, BadgeProps['status']> = {
  OPENING: 'default',
  IDLE: 'success',
  RUNNING: 'processing',
  ASKING: 'warning',
  QUESTIONING: 'warning',
  CLOSED: 'default',
}

const CLOSE_REASONS: Record<SessionCloseReason, MessageKey> = {
  closed: 'closeClosed',
  idle: 'closeIdle',
  shutdown: 'closeShutdown',
  exited: 'closeExited',
  deleted: 'closeDeleted',
}

/** Official platform marks from assets/overview-light.svg and overview-dark.svg; the black ones turn white in dark */
const ADAPTER_ICONS: Record<'light' | 'dark', Record<string, string>> = {
  light: { codex: codexIcon, claude: claudeIcon, grok: grokIcon, opencode: opencodeIcon, antigravity: antigravityIcon, pi: piIcon },
  dark: { codex: codexDarkIcon, claude: claudeIcon, grok: grokDarkIcon, opencode: opencodeDarkIcon, antigravity: antigravityIcon, pi: piIcon },
}

/** The token behind each Badge status dot, so the state text matches its dot. */
export function statusColor(status: BadgeProps['status'], token: GlobalToken): string {
  if (status === 'success') return token.colorSuccess
  if (status === 'processing') return token.colorInfo
  if (status === 'warning') return token.colorWarning
  return token.colorTextPlaceholder
}

const STATE_KEYS: Record<AgentState, MessageKey> = {
  OPENING: 'stateOPENING',
  IDLE: 'stateIDLE',
  RUNNING: 'stateRUNNING',
  ASKING: 'stateASKING',
  QUESTIONING: 'stateQUESTIONING',
  CLOSED: 'stateCLOSED',
}

export const sessionKey = (session: Conversation) => `${session.mcp_id}/${session.session}`

/** The MCP `state` of the session in the current language; an ended session is CLOSED. */
export const stateLabel = (session: Conversation, t: Translate) => t(STATE_KEYS[session.closed ? 'CLOSED' : session.state])

/** Why the session ended, or that its MCP server is gone; null while it is live. Not an MCP state. */
export function sessionNote(session: Conversation, mcp: McpInfo | undefined, t: Translate): string | null {
  if (session.closed) return t('ended', { reason: t(CLOSE_REASONS[session.closed]) })
  return mcp?.connected ? null : t('disconnected')
}

/** The agent's title, else the first prompt the caller sent, else the session id. */
function sessionName(session: Conversation): string {
  const prompt = session.items.find(i => i.kind === 'prompt' && i.data.internal !== true)
  return session.title ?? (text(obj(list(prompt?.data.prompt)[0]).text) || session.session)
}

interface SessionListProps {
  mcps: McpInfo[]
  sessions: Conversation[]
  activeKey: string | undefined
  onSelect: (key: string) => void
}

/** Subagents (platform icon and config name), each holding its sessions across MCP servers. */
export default function SessionList({ mcps, sessions, activeKey, onSelect }: SessionListProps) {
  const { t, dark } = usePreferences()
  const { token } = theme.useToken()
  const icons = ADAPTER_ICONS[dark ? 'dark' : 'light']
  const [collapsed, setCollapsed] = useState<string[]>([])
  // The same subagent name may point to another platform in another project's config
  const groups = [...new Set(sessions.map(s => `${s.adapter}/${s.subagent}`))]
  const items: MenuProps['items'] = groups.map(group => {
    const members = sessions.filter(s => `${s.adapter}/${s.subagent}` === group)
    const { adapter, subagent } = members[0]
    return {
      key: group,
      icon: <Tooltip title={adapter}><Avatar shape="square" size={22} src={icons[adapter]} style={{ marginInlineEnd: 10 }}>{adapter.slice(0, 1).toUpperCase()}</Avatar></Tooltip>,
      label: subagent,
      children: members.map(session => {
        const mcp = mcps.find(m => m.mcp_id === session.mcp_id)
        const ended = session.closed !== null || !mcp?.connected
        const note = sessionNote(session, mcp, t)
        const status = ended ? 'default' : STATE_BADGES[session.state]
        return {
          key: sessionKey(session),
          icon: <Badge status={status} />,
          label: (
            <Tooltip
              placement="bottomLeft"
              title={(
                <Flex vertical>
                  <Typography.Text>{sessionName(session)}</Typography.Text>
                  <Typography.Text type="secondary">{t('mcpTooltip', { cwd: mcp?.cwd ?? session.cwd, pid: mcp?.pid ?? '?' })}</Typography.Text>
                  {note && <Typography.Text type="secondary">{note}</Typography.Text>}
                </Flex>
              )}
              color="var(--ant-color-bg-elevated)"
            >
              <Typography.Text type={ended ? 'secondary' : undefined}>{sessionName(session)}</Typography.Text>
            </Tooltip>
          ),
          extra: (
            <Flex gap={4} align="center" style={{ color: statusColor(status, token) }}>
              {session.closed === null && !mcp?.connected && <DisconnectOutlined />}
              {stateLabel(session, t)}
            </Flex>
          ),
        }
      }),
    }
  })
  return (
    <Menu
      mode="inline"
      items={items}
      selectedKeys={activeKey ? [activeKey] : []}
      openKeys={groups.filter(group => !collapsed.includes(group))}
      onOpenChange={keys => setCollapsed(groups.filter(group => !keys.includes(group)))}
      onClick={({ key }) => onSelect(key)}
    />
  )
}
