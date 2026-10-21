import { Alert, Flex, Tag, Typography } from 'antd'
import type { JsonObject, ConversationItem } from '../../../types'
import { list, obj, text } from '../json'
import { usePreferences } from '../preferences'

const ACTION_COLORS: Record<string, string> = { accept: 'green', decline: 'orange', cancel: 'default' }

interface Choice {
  value: string
  label: string
}

/** Choices of a form field: oneOf/anyOf entries by title, else enum values. A multi-select takes its items' choices. */
function choicesOf(field: JsonObject): Choice[] {
  const source = field.type === 'array' ? obj(field.items) : field
  const titled = [...list(source.oneOf), ...list(source.anyOf)].map(obj).map(choice => ({ value: text(choice.const), label: text(choice.title) || text(choice.const) }))
  return titled.length > 0 ? titled : list(source.enum).map(value => ({ value: text(value), label: text(value) }))
}

/** A form field before it is answered: its title, required mark, choices (or type) and description. */
function Field({ name, field, required }: { name: string; field: JsonObject; required: boolean }) {
  const choices = choicesOf(field)
  return (
    <Flex vertical gap={2}>
      <Flex gap={6} wrap align="center">
        <Typography.Text strong>{text(field.title) || name}</Typography.Text>
        {required && <Typography.Text type="danger">*</Typography.Text>}
        {choices.length > 0 ? choices.map(choice => <Tag key={choice.value}>{choice.label}</Tag>) : <Tag bordered={false}>{text(field.type)}</Tag>}
      </Flex>
      {field.description !== undefined && <Typography.Text type="secondary">{text(field.description)}</Typography.Text>}
    </Flex>
  )
}

/**
 * An elicitation/create form question. Before an answer it lists the form's fields; an accepted answer
 * shows one `field → answer` line per field, as Claude Code's terminal does. One without a question_id
 * was answered `cancel` outside a turn.
 */
export default function QuestionCard({ item }: { item: ConversationItem }) {
  const { t } = usePreferences()
  const { data } = item
  const result = obj(data.result)
  const action = text(data.action) || text(result.action)
  const schema = obj(data.requestedSchema)
  const properties = obj(schema.properties)
  const required = list(schema.required).map(text)
  const answers = Object.entries(obj(result.content)).map(([name, value]) => {
    const field = obj(properties[name])
    const choices = choicesOf(field)
    const shown = (Array.isArray(value) ? value : [value]).map(entry => choices.find(choice => choice.value === text(entry))?.label ?? text(entry)).join(', ')
    return (
      <Flex key={name} gap={6} wrap>
        <Typography.Text type="secondary">{text(field.title) || name}</Typography.Text>
        <Typography.Text type="secondary">→</Typography.Text>
        <Typography.Text strong>{shown}</Typography.Text>
      </Flex>
    )
  })
  return (
    <Alert
      type="info"
      title={t('question', { message: text(data.message) })}
      description={(
        <Flex vertical gap={8}>
          {answers.length > 0
            ? <Flex vertical gap={2}>{answers}</Flex>
            : Object.entries(properties).map(([name, field]) => <Field key={name} name={name} field={obj(field)} required={required.includes(name)} />)}
          <Flex gap={4} align="center">
            <Typography.Text type="secondary">{t('answer')}</Typography.Text>
            {action ? <Tag color={ACTION_COLORS[action]}>{action}</Tag> : <Tag color="processing">{t('waiting')}</Tag>}
            {data.question_id === undefined && action && <Tag>{t('skipped')}</Tag>}
            {data.question_id !== undefined && <Typography.Text type="secondary" code>{text(data.question_id)}</Typography.Text>}
          </Flex>
        </Flex>
      )}
    />
  )
}
