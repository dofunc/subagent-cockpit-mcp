import type { CSSProperties } from 'react'
import { Badge, Descriptions, Flex, Progress, Tag, theme, Typography } from 'antd'
import type { McpInfo, Conversation } from '../../../types'
import { json, list, obj, text } from '../json'
import { usePreferences } from '../preferences'
import Code from './Code'
import Compact from './Compact'
import { sessionNote, STATE_BADGES, stateLabel, statusColor } from './SessionList'

/** Labels stay on one line so each row keeps a single line's height */
const LABEL_NOWRAP: { label: CSSProperties } = { label: { whiteSpace: 'nowrap' } }

interface SessionInfoProps {
  session: Conversation
  mcp: McpInfo | undefined
}

/** Current value of a select option by name; grouped options are flattened first. */
function optionName(option: ReturnType<typeof obj>): string {
  const choices = list(option.options).flatMap(choice => (Array.isArray(obj(choice).options) ? list(obj(choice).options) : [choice]))
  const current = choices.map(obj).find(choice => choice.value === option.currentValue)
  return current ? text(current.name) : text(option.currentValue)
}

/** Who the session is, where it runs, and the agent's latest mode, model, config, usage and commands. */
export default function SessionInfo({ session, mcp }: SessionInfoProps) {
  const { t } = usePreferences()
  const { info } = session
  const agent = obj(info.agentInfo)
  const modes = obj(info.modes)
  const models = obj(info.models)
  const usage = obj(info.usage)
  const cost = obj(usage.cost)
  const used = Number(usage.used ?? 0)
  const size = Number(usage.size ?? 0)
  const commands = list(info.availableCommands).map(obj)
  const modeName = text(obj(list(modes.availableModes).map(obj).find(m => m.id === modes.currentModeId)).name) || text(modes.currentModeId)
  const modelName = text(obj(list(models.availableModels).map(obj).find(m => m.modelId === models.currentModelId)).name) || text(models.currentModelId)
  const { token } = theme.useToken()
  const note = sessionNote(session, mcp, t)
  const status = note ? 'default' : STATE_BADGES[session.state]
  const capabilities = { protocolVersion: info.protocolVersion ?? null, agentCapabilities: info.agentCapabilities ?? null, authMethods: info.authMethods ?? null }

  const items = [
    {
      key: 'state',
      label: t('fieldState'),
      children: (
        <Flex gap={6} align="center" wrap>
          <Badge status={status} text={<Typography.Text style={{ color: statusColor(status, token) }}>{stateLabel(session, t)}</Typography.Text>} />
          {session.cancelling && !note && <Tag color="orange">{t('cancelling')}</Tag>}
          {note && <Typography.Text type="secondary">{note}</Typography.Text>}
        </Flex>
      ),
    },
    { key: 'subagent', label: t('fieldSubagent'), children: session.subagent },
    { key: 'adapter', label: t('fieldAdapter'), children: session.adapter },
    { key: 'agent', label: t('fieldAgent'), children: agent.name ? `${text(agent.title) || text(agent.name)} ${text(agent.version)}` : t('unknown') },
    { key: 'session', label: t('fieldSession'), children: <Typography.Text copyable>{session.session}</Typography.Text> },
    { key: 'cwd', label: t('fieldCwd'), children: <Typography.Text copyable>{session.cwd}</Typography.Text> },
    { key: 'mcp', label: t('fieldMcp'), children: mcp ? `${mcp.cwd} · pid ${mcp.pid}${mcp.connected ? '' : ` · ${t('disconnected')}`}` : '-' },
    { key: 'title', label: t('fieldTitle'), children: session.title ?? '-' },
    { key: 'mode', label: t('fieldMode'), children: modeName || '-' },
    { key: 'model', label: t('fieldModel'), children: modelName || '-' },
    {
      key: 'usage',
      label: t('fieldContext'),
      children: size > 0
        ? <Flex gap={8} align="center"><Progress percent={Math.round((used / size) * 100)} size="small" style={{ width: 120, margin: 0 }} /><Typography.Text type="secondary">{`${used.toLocaleString()} / ${size.toLocaleString()}${cost.amount === undefined ? '' : ` · ${text(cost.amount)} ${text(cost.currency)}`}`}</Typography.Text></Flex>
        : '-',
    },
    // Filled by the platform parsers: codex and claude report the login in use, codex its thread status
    ...(info.auth === undefined ? [] : [{ key: 'auth', label: t('fieldAuth'), children: [text(obj(info.auth).label), text(obj(info.auth).detail)].filter(Boolean).join(' · ') || '-' }]),
    ...(info.threadStatus === undefined ? [] : [{ key: 'thread', label: t('fieldThread'), children: [text(obj(info.threadStatus).type), ...list(obj(info.threadStatus).activeFlags).map(text)].filter(Boolean).join(' · ') || '-' }]),
    {
      key: 'config',
      label: t('fieldConfig'),
      children: (
        <Flex gap={4} wrap>
          {list(info.configOptions).map(obj).map(option => (
            <Tag key={text(option.id)}>{`${text(option.name)}: ${option.type === 'boolean' ? text(option.currentValue) : optionName(option)}`}</Tag>
          ))}
        </Flex>
      ),
    },
  ]
  return (
    <Compact>
      <Flex vertical gap={24} style={{ height: '100%', overflow: 'auto', paddingBottom: 24 }}>
        <Descriptions column={2} bordered items={items} styles={LABEL_NOWRAP} />
        <Flex vertical>
          <Typography.Title level={5}>{t('availableCommands')}</Typography.Title>
          <Descriptions
            column={1}
            bordered
            styles={LABEL_NOWRAP}
            items={commands.length > 0 ? commands.map(c => ({ key: text(c.name), label: `/${text(c.name)}`, children: text(c.description) })) : [{ key: 'none', label: '-', children: t('none') }]}
          />
        </Flex>
        <Flex vertical>
          <Typography.Title level={5}>{t('agentCapabilities')}</Typography.Title>
          <Code lang="json" header={false}>{json(capabilities)}</Code>
        </Flex>
      </Flex>
    </Compact>
  )
}
