import { Flex, Tag, Typography } from 'antd'
import { FileCard, ThoughtChain } from '@ant-design/x'
import type { ThoughtChainItemType } from '@ant-design/x'
import type { JsonValue, ConversationItem } from '../../../types'
import { list, obj, text } from '../json'
import { usePreferences } from '../preferences'
import { Markdown } from './ContentBlockView'

const PRIORITY_COLORS: Record<string, string> = { high: 'red', medium: 'gold', low: 'default' }

/** Plan entry status -> ThoughtChain status; pending entries show no icon */
const STATUS_MAP: Record<string, ThoughtChainItemType['status']> = { in_progress: 'loading', completed: 'success' }

function Entries({ entries }: { entries: JsonValue[] }) {
  const items = entries.map(obj).map((entry, index) => ({
    key: String(index),
    title: text(entry.content),
    description: <Flex gap={4}><Tag color={PRIORITY_COLORS[text(entry.priority)]}>{text(entry.priority)}</Tag><Tag bordered={false}>{text(entry.status)}</Tag></Flex>,
    status: STATUS_MAP[text(entry.status)],
  }))
  return <ThoughtChain items={items} />
}

/** `plan` carries entries; `plan_update` carries one plan by planId as items, markdown or a file. */
export default function PlanCard({ item }: { item: ConversationItem }) {
  const { t } = usePreferences()
  const { data } = item
  const plan = obj(data.plan)
  const planId = text(plan.planId)
  const body = data.sessionUpdate === 'plan'
    ? <Entries entries={list(data.entries)} />
    : plan.type === 'items'
      ? <Entries entries={list(plan.entries)} />
      : plan.type === 'markdown'
        ? <Markdown content={text(plan.content)} />
        : plan.type === 'file'
          ? <FileCard name={text(plan.uri).replace(/^.*\//, '')} icon="markdown" description={text(plan.uri)} />
          : null
  return (
    <Flex vertical gap={8}>
      <Flex gap={6} align="center">
        <Typography.Text strong>{planId ? t('planNamed', { id: planId }) : t('plan')}</Typography.Text>
        {plan.type !== undefined && <Tag bordered={false}>{text(plan.type)}</Tag>}
        {data.removed === true && <Tag color="default">{t('removed')}</Tag>}
      </Flex>
      {body}
    </Flex>
  )
}
