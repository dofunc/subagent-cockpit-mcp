import type { ReactNode } from 'react'
import { ConfigProvider, theme } from 'antd'
import { usePreferences } from '../preferences'

interface CompactProps {
  /** A font for every antd component inside; they set font-family from the token instead of inheriting it */
  font?: string
  children: ReactNode
}

/**
 * Ant Design X ignores componentSize, so tabs holding X components run on the compact theme; antd
 * parts inside stay small. A nested theme replaces the outer algorithm, so dark is repeated here.
 */
export default function Compact({ font, children }: CompactProps) {
  const { dark } = usePreferences()
  const token = font ? { fontFamily: font, fontFamilyCode: font } : undefined
  return (
    <ConfigProvider theme={{ algorithm: dark ? [theme.darkAlgorithm, theme.compactAlgorithm] : theme.compactAlgorithm, token }}>
      {children}
    </ConfigProvider>
  )
}
