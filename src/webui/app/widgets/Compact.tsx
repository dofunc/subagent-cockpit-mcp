import type { ReactNode } from 'react'
import { ConfigProvider, theme } from 'antd'
import { usePreferences } from '../preferences'

/**
 * Ant Design X ignores componentSize, so tabs holding X components run on the compact theme; antd
 * parts inside stay small. A nested theme replaces the outer algorithm, so dark is repeated here.
 */
export default function Compact({ children }: { children: ReactNode }) {
  const { dark } = usePreferences()
  return (
    <ConfigProvider theme={{ algorithm: dark ? [theme.darkAlgorithm, theme.compactAlgorithm] : theme.compactAlgorithm }}>
      {children}
    </ConfigProvider>
  )
}
