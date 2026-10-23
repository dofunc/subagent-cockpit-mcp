import { useEffect, useRef, useState } from 'react'
import { Flex, Table, Tag, theme, Tooltip, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons'
import type { MessageLogEntry, Conversation } from '../../../types'
import { usePreferences } from '../preferences'
import Code from './Code'
import Compact from './Compact'

const SUMMARY_LENGTH = 160
/** Table header plus the pagination bar on the compact theme, taken off the measured height to size the scroll area */
const TABLE_CHROME = 67

/** The arrow points the way the message travelled, with the agent as the fixed end. */
export function DirectionTag({ direction }: Pick<MessageLogEntry, 'direction'>) {
  const { t } = usePreferences()
  return <Tag color={direction === 'out' ? 'green' : 'blue'}>{t(direction === 'out' ? 'toAgent' : 'fromAgent')}</Tag>
}

/** Method for requests and notifications, `result` / `error` with the id for responses. */
function describe({ message }: MessageLogEntry): string {
  if ('truncated' in message) return `${message.method ?? 'response'} (truncated)`
  if (message.method) return message.id === undefined ? message.method : `${message.method} #${message.id}`
  return `${message.error ? 'error' : 'result'} #${message.id ?? '?'}`
}

/** Arrow and method in one color: green going to the agent, blue coming from it. */
function MessageCell({ entry }: { entry: MessageLogEntry }) {
  const { t } = usePreferences()
  const { token } = theme.useToken()
  const out = entry.direction === 'out'
  const color = out ? token.colorSuccess : token.colorPrimary
  return (
    <Flex gap={6} align="center">
      <Tooltip title={t(out ? 'sentToAgent' : 'receivedFromAgent')}>
        {out ? <ArrowRightOutlined style={{ color }} /> : <ArrowLeftOutlined style={{ color }} />}
      </Tooltip>
      <Typography.Text code style={{ color }}>{describe(entry)}</Typography.Text>
    </Flex>
  )
}

export default function ProtocolLog({ session }: { session: Conversation }) {
  const { t } = usePreferences()
  const container = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)

  // The scroll area follows the tab's height as the window or the splitter changes size
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height))
    container.current && observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  const columns: TableColumnsType<MessageLogEntry> = [
    { title: '#', dataIndex: 'seq', width: 64 },
    { title: t('colTime'), dataIndex: 'at', width: 120, render: (at: number) => new Date(at).toISOString().slice(11, 23) },
    { title: t('colMessage'), width: 280, render: (_, entry) => <MessageCell entry={entry} /> },
    {
      title: t('colSummary'),
      ellipsis: true,
      render: (_, { message }) => <Typography.Text type="secondary">{JSON.stringify('truncated' in message ? message : message.params ?? message.result ?? message.error ?? null).slice(0, SUMMARY_LENGTH)}</Typography.Text>,
    },
  ]

  return (
    <Compact>
      <Flex ref={container} vertical style={{ height: '100%' }}>
        <Table<MessageLogEntry>
          rowKey="seq"
          columns={columns}
          // Newest first, so the latest traffic is on the first page
          dataSource={[...session.log].reverse()}
          pagination={{ defaultPageSize: 100, showSizeChanger: true }}
          scroll={{ y: Math.max(height - TABLE_CHROME, 120) }}
          expandable={{ expandedRowRender: entry => <Code lang="json">{JSON.stringify(entry.message, null, 2)}</Code> }}
        />
      </Flex>
    </Compact>
  )
}
