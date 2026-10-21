import { useState } from 'react'
import { Collapse, Flex, Tag, theme, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { createTwoFilesPatch } from 'diff'
import type { JsonObject, JsonValue, ConversationItem } from '../../../types'
import { list, obj, text } from '../json'
import { usePreferences } from '../preferences'
import Code from './Code'
import ContentBlockView, { Markdown } from './ContentBlockView'
import KeyValues from './KeyValues'

/** Text output longer than this shows its first lines and expands in place, as Claude Code's terminal does */
const FOLD_LINES = 3

const isFence = (line: string) => /^\s*```/.test(line)

/**
 * Tool output text, folded to its first lines. Blank and fence lines don't count, a fence cut open is
 * closed again, and a single extra line is not worth a fold.
 */
function FoldedText({ content }: { content: string }) {
  const { t } = usePreferences()
  const [open, setOpen] = useState(false)
  const lines = content.replace(/\n+$/, '').split('\n')
  const textLines = lines.flatMap((line, index) => (isFence(line) || line.trim() === '' ? [] : [index]))
  if (textLines.length <= FOLD_LINES + 1) return <Markdown content={content} breaks />
  const head = lines.slice(0, textLines[FOLD_LINES - 1] + 1)
  const preview = head.filter(isFence).length % 2 === 1 ? [...head, '```'] : head
  return (
    <Flex vertical gap={4}>
      <Markdown content={open ? content : preview.join('\n')} breaks />
      <Typography.Link onClick={() => setOpen(!open)}>{open ? t('showLess') : t('moreLines', { count: textLines.length - FOLD_LINES })}</Typography.Link>
    </Flex>
  )
}

/**
 * A diff as a unified patch. Prism's diff grammar colors only the text, so added and removed lines also get
 * a full-width green or red background, as Claude Code's terminal shows them. react-syntax-highlighter hands
 * `lineProps` a line number only with `showLineNumbers` on, so the numbers are on and hidden.
 */
function Diff({ fields }: { fields: JsonObject }) {
  const { t } = usePreferences()
  const { token } = theme.useToken()
  const path = text(fields.path)
  const patch = createTwoFilesPatch(path, path, text(fields.oldText), text(fields.newText))
  const lines = patch.split('\n')
  const background = (line: string) => (/^\+(?!\+\+ )/.test(line) ? token.colorSuccessBg : /^-(?!-- )/.test(line) ? token.colorErrorBg : undefined)
  return (
    <Code
      lang="diff"
      header={`${t(fields.oldText === undefined || fields.oldText === null ? 'newFile' : 'edit')} · ${path}`}
      highlightProps={{
        wrapLines: true,
        showLineNumbers: true,
        lineNumberStyle: { display: 'none' },
        lineProps: (lineNumber: number) => ({ style: { display: 'block', background: background(lines[lineNumber - 1]) } }),
      }}
    >
      {patch}
    </Code>
  )
}

/** One piece of tool output: content, diff or terminal. */
function ToolContent({ content }: { content: JsonValue }) {
  const { t } = usePreferences()
  const fields = obj(content)
  const block = obj(fields.content)
  if (fields.type === 'content' && block.type === 'text') return <FoldedText content={text(block.text)} />
  if (fields.type === 'content') return <ContentBlockView block={fields.content ?? null} breaks />
  if (fields.type === 'diff') return <Diff fields={fields} />
  if (fields.type === 'terminal') return <Tag>{t('terminal', { id: text(fields.terminalId) })}</Tag>
  return <KeyValues value={content} />
}

/** ACP tool status as an icon: running spins, then a check or a cross; no status is a dash. */
function StatusIcon({ status }: { status: string }) {
  const { token } = theme.useToken()
  if (status === 'pending' || status === 'in_progress') return <LoadingOutlined style={{ color: token.colorPrimary }} />
  if (status === 'completed') return <CheckCircleOutlined style={{ color: token.colorSuccess }} />
  if (status === 'failed') return <CloseCircleOutlined style={{ color: token.colorError }} />
  return <MinusCircleOutlined style={{ color: token.colorTextTertiary }} />
}

/**
 * A tool call as a Collapse panel, open by default. ThoughtChain sizes its content to fit, so code
 * blocks stayed narrow there; Collapse fills the row. The title already names the command or file, so
 * rawInput starts folded; rawOutput shows only when the agent sent no content. `_meta` is vendor data
 * and stays on the protocol log tab.
 */
export default function ToolCallCard({ item }: { item: ConversationItem }) {
  const { t } = usePreferences()
  const { data } = item
  const status = text(data.status)
  const locations = list(data.locations).map(obj).map(l => (l.line === undefined || l.line === null ? text(l.path) : `${text(l.path)}:${text(l.line)}`))
  const contents = list(data.content)
  const input = data.rawInput ?? null
  const output = contents.length === 0 ? data.rawOutput ?? null : null
  // Command output that only came as `_meta.terminal_output_delta` (codex), joined by its parser
  const terminal = contents.length === 0 ? text(data.terminal_output) : ''
  const label = (
    <Flex vertical gap={4}>
      <Flex gap={8} align="center">
        <StatusIcon status={status} />
        <Typography.Text strong>{text(data.title) || text(data.toolCallId)}</Typography.Text>
      </Flex>
      <Flex gap={6} wrap>
        <Tag bordered={false}>{text(data.kind) || 'other'}</Tag>
        {data.tool_name !== undefined && <Tag bordered={false} color="blue">{text(data.tool_name)}</Tag>}
        <Tag bordered={false}>{status || t('noStatus')}</Tag>
        {data.subagent_state !== undefined && <Tag bordered={false} color="orange">{text(data.subagent_state)}</Tag>}
        {data.sessionUpdate === 'tool_call_update' && <Tag color="orange">{t('noToolCallStart')}</Tag>}
        {locations.map(location => <Typography.Text key={location} type="secondary" code>{location}</Typography.Text>)}
      </Flex>
    </Flex>
  )
  const body = contents.length > 0 || input !== null || output !== null || terminal
    ? (
      <Flex vertical gap={8}>
        {input !== null && <Collapse ghost size="small" items={[{ key: 'input', label: t('toolInput'), children: <KeyValues value={input} /> }]} />}
        {contents.map((content, index) => <ToolContent key={index} content={content} />)}
        {terminal && <FoldedText content={`\`\`\`\n${terminal.replace(/\n$/, '')}\n\`\`\``} />}
        {output !== null && <KeyValues value={output} />}
      </Flex>
    )
    : null
  return (
    <Collapse
      defaultActiveKey={body ? [item.id] : []}
      items={[{ key: item.id, label, children: body, collapsible: body ? undefined : 'disabled', showArrow: body !== null }]}
    />
  )
}
