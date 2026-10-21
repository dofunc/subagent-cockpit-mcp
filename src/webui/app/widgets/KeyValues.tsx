import type { CSSProperties } from 'react'
import { Descriptions, Typography } from 'antd'
import type { JsonValue } from '../../../types'
import { isObject } from '../../transcript'

/** Labels stay on one line; values wrap */
const LABEL_NOWRAP: { label: CSSProperties } = { label: { whiteSpace: 'nowrap' } }

/**
 * One value: text as is (three lines, then expandable), a list of strings joined by spaces (a command
 * reads as typed), anything else as one line of JSON in code style.
 */
function Value({ value }: { value: JsonValue }) {
  if (typeof value === 'string') {
    return <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }} ellipsis={{ rows: 3, expandable: 'collapsible' }}>{value}</Typography.Paragraph>
  }
  if (Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string')) return <Value value={value.join(' ')} />
  return <Typography.Text code style={{ wordBreak: 'break-all' }}>{JSON.stringify(value)}</Typography.Text>
}

/** A JSON value as a key/value list: an object lists its fields one level deep, anything else is one value. Keys are shown as received. */
export default function KeyValues({ value }: { value: JsonValue }) {
  if (!isObject(value)) return <Value value={value} />
  const items = Object.entries(value).map(([key, field]) => ({ key, label: key, children: <Value value={field} /> }))
  return <Descriptions column={1} size="small" items={items} styles={LABEL_NOWRAP} />
}
