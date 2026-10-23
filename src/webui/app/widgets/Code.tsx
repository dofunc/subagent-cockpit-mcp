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

/**
 * CodeHighlighter always paints oneLight; this follows the page's light or dark theme. The Prism theme fixes
 * its font on pre and code, so the conversation tab's font variable wins there, and the theme's font elsewhere.
 */
export default function Code({ lang, header, highlightProps, children }: CodeProps) {
  const { dark } = usePreferences()
  const style = dark ? oneDark : oneLight
  const fontFamily = `var(--cockpit-conversation-font, ${style['pre[class*="language-"]']?.fontFamily ?? 'monospace'})`
  return (
    <CodeHighlighter
      lang={lang}
      header={header}
      highlightProps={{
        ...highlightProps,
        style,
        customStyle: { margin: 0, fontFamily },
        codeTagProps: { style: { ...style['code[class*="language-"]'], fontFamily } },
      }}
    >
      {children}
    </CodeHighlighter>
  )
}
