import { Alert, Flex, Tag, Typography } from 'antd'
import type { ConversationItem } from '../../../types'
import type { MessageKey } from '../i18n'
import { list, obj, text } from '../json'
import { usePreferences } from '../preferences'
import Code from './Code'
import KeyValues from './KeyValues'

/** resolution -> [tag color, label]; `auto` marks a request answered by a session allow rule */
const RESOLUTIONS: Record<string, [string, MessageKey]> = {
  approve: ['green', 'approved'],
  allow: ['cyan', 'allowed'],
  reject: ['red', 'rejected'],
  cancelled: ['default', 'cancelled'],
  auto: ['blue', 'autoApproved'],
}

/**
 * A permission request, as Claude Code's terminal shows it: the title with rawInput's description on one
 * line, then the command in a code box unless the title already is the command. A request with neither a
 * command nor a description lists its rawInput fields.
 */
export default function ApprovalCard({ item }: { item: ConversationItem }) {
  const { t } = usePreferences()
  const { data } = item
  const toolCall = obj(data.toolCall)
  const input = toolCall.rawInput ?? null
  const fields = obj(input)
  const command = Array.isArray(fields.command) ? fields.command.map(text).join(' ') : text(fields.command)
  const description = text(fields.description)
  const title = text(toolCall.title) || text(toolCall.toolCallId)
  const outcome = obj(obj(data.result).outcome)
  const chosen = text(outcome.optionId) || text(data.option_id)
  const [color, label] = RESOLUTIONS[text(data.resolution)] ?? (outcome.outcome === 'cancelled' ? RESOLUTIONS.cancelled : ['processing', 'waiting'])
  return (
    <Alert
      type="warning"
      title={(
        <>
          {t('permission', { title })}
          {description && <Typography.Text type="secondary">{` · ${description}`}</Typography.Text>}
        </>
      )}
      description={(
        <Flex vertical gap={8}>
          {command && command !== title && <Code lang="bash" header={false}>{command}</Code>}
          {input !== null && !command && !description && <KeyValues value={input} />}
          <Flex gap={4} wrap align="center">
            <Typography.Text type="secondary">{t('options')}</Typography.Text>
            {list(data.options).map(obj).map(option => (
              <Tag key={text(option.optionId)} color={text(option.optionId) === chosen ? color : undefined}>
                {`${text(option.name)} (${text(option.kind)})`}
              </Tag>
            ))}
          </Flex>
          <Flex gap={4} align="center">
            <Typography.Text type="secondary">{t('answer')}</Typography.Text>
            <Tag color={color}>{t(label)}</Tag>
            {data.approval_id !== undefined && <Typography.Text type="secondary" code>{text(data.approval_id)}</Typography.Text>}
          </Flex>
        </Flex>
      )}
    />
  )
}
