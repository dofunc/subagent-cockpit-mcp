import type { ReactNode } from 'react'
import { CodeHighlighter } from '@ant-design/x'
import type { CodeHighlighterProps } from '@ant-design/x'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { usePreferences } from '../preferences'

interface CodeProps {
  lang: string
  header?: ReactNode
  /** Passed on to react-syntax-highlighter, e.g. `wrapLines` and `lineProps` for per-line backgrounds */
  highlightProps?: CodeHighlighterProps['highlightProps']
  children: string
}

/** CodeHighlighter always paints oneLight; this follows the page's light or dark theme. */
export default function Code({ lang, header, highlightProps, children }: CodeProps) {
  const { dark } = usePreferences()
  return (
    <CodeHighlighter lang={lang} header={header} highlightProps={{ ...highlightProps, style: dark ? oneDark : oneLight, customStyle: { margin: 0 } }}>
      {children}
    </CodeHighlighter>
  )
}
