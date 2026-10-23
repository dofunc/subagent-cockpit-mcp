import { Flex } from 'antd'
import { FileCard } from '@ant-design/x'
import { XMarkdown } from '@ant-design/x-markdown'
import type { JsonValue } from '../../../types'
import { obj, text } from '../json'
import { usePreferences } from '../preferences'
import Code from './Code'
import KeyValues from './KeyValues'

interface ContentBlockViewProps {
  block: JsonValue
  /** The block may still grow: markdown renders its unfinished tail as it streams */
  streaming?: boolean
  /** Every newline breaks the line, as in the terminal; on by default */
  breaks?: boolean
}

interface MarkdownProps {
  content: string
  streaming?: boolean
  breaks?: boolean
}

/** Markdown in the page's light or dark theme. A single newline breaks the line unless `breaks` is false. */
export function Markdown({ content, streaming = false, breaks = true }: MarkdownProps) {
  const { dark } = usePreferences()
  return <XMarkdown className={dark ? 'x-markdown-dark' : 'x-markdown-light'} content={content} streaming={{ hasNextChunk: streaming }} config={{ breaks }} />
}

/** One ACP content block: text, image, audio, resource_link or resource; anything else as a key/value list. */
export default function ContentBlockView({ block, streaming = false, breaks = true }: ContentBlockViewProps) {
  const { t } = usePreferences()
  const fields = obj(block)
  const mimeType = text(fields.mimeType)
  switch (fields.type) {
    case 'text':
      return <Markdown content={text(fields.text)} streaming={streaming} breaks={breaks} />
    case 'image':
      return <FileCard type="image" name={text(fields.uri) || mimeType} src={`data:${mimeType};base64,${text(fields.data)}`} />
    case 'audio':
      return <FileCard type="audio" name={mimeType} src={`data:${mimeType};base64,${text(fields.data)}`} />
    case 'resource_link':
      return (
        <FileCard
          name={text(fields.title) || text(fields.name)}
          byte={typeof fields.size === 'number' ? fields.size : undefined}
          description={[text(fields.uri), text(fields.description)].filter(Boolean).join(' · ')}
        />
      )
    case 'resource': {
      const resource = obj(fields.resource)
      return (
        <Flex vertical gap={8}>
          <FileCard name={text(resource.uri)} description={text(resource.mimeType) || undefined} />
          {resource.text !== undefined
            ? <Code lang={text(resource.mimeType).replace(/^text\//, '') || 'text'}>{text(resource.text)}</Code>
            : <Code lang="text">{t('blob', { count: text(resource.blob).length })}</Code>}
        </Flex>
      )
    }
    default:
      return <KeyValues value={block} />
  }
}
