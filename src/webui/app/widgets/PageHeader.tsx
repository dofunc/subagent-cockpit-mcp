import { Button, Dropdown, Flex, Layout, Segmented, theme, Typography } from 'antd'
import { GlobalOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons'
import { isLang, LANGUAGES } from '../i18n'
import type { Preferences } from '../preferences'
import { usePreferences } from '../preferences'

interface PageHeaderProps {
  onChange: (preferences: Preferences) => void
}

/** Title on the left; a globe menu for the language and a light / dark switch on the right. */
export default function PageHeader({ onChange }: PageHeaderProps) {
  const { t, lang, dark } = usePreferences()
  const { token } = theme.useToken()
  return (
    <Layout.Header style={{ padding: '0 16px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <Flex justify="space-between" align="center" style={{ height: '100%' }}>
        <Flex gap={8} align="baseline">
          <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>{t('title')}</Typography.Text>
          <Typography.Text type="secondary">{t('subtitle')}</Typography.Text>
        </Flex>
        <Flex gap={12} align="center">
          <Dropdown
            menu={{ items: LANGUAGES, selectable: true, selectedKeys: [lang], onClick: ({ key }) => isLang(key) && onChange({ lang: key, dark }) }}
            placement="bottom"
            arrow={{ pointAtCenter: true }}
          >
            <Button type="text" icon={<GlobalOutlined />} aria-label={t('language')} />
          </Dropdown>
          <Segmented<'light' | 'dark'>
            value={dark ? 'dark' : 'light'}
            options={[
              { value: 'light', icon: <SunOutlined />, title: t('light') },
              { value: 'dark', icon: <MoonOutlined />, title: t('dark') },
            ]}
            onChange={value => onChange({ lang, dark: value === 'dark' })}
          />
        </Flex>
      </Flex>
    </Layout.Header>
  )
}
