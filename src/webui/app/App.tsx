import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Empty, Layout, Splitter, Tabs, theme } from 'antd'
import antdEnUS from 'antd/locale/en_US'
import antdJaJP from 'antd/locale/ja_JP'
import antdZhCN from 'antd/locale/zh_CN'
import antdZhTW from 'antd/locale/zh_TW'
import { XProvider } from '@ant-design/x'
import xEnUS from '@ant-design/x/locale/en_US'
import xZhCN from '@ant-design/x/locale/zh_CN'
import { translate } from './i18n'
import type { Lang, Translate } from './i18n'
import { loadPreferences, PreferencesContext, savePreferences } from './preferences'
import type { Preferences } from './preferences'
import { connect, ConversationStore } from './store'
import PageHeader from './widgets/PageHeader'
import ProtocolLog from './widgets/ProtocolLog'
import SessionInfo from './widgets/SessionInfo'
import SessionList, { sessionKey } from './widgets/SessionList'
import Transcript from './widgets/Transcript'

const store = new ConversationStore()

// Ant Design X ships English and Simplified Chinese only; the other languages take its English text
const LOCALES: Record<Lang, typeof antdEnUS & typeof xEnUS> = {
  'en': { ...antdEnUS, ...xEnUS },
  'zh-CN': { ...antdZhCN, ...xZhCN },
  'zh-TW': { ...antdZhTW, ...xEnUS },
  'ja': { ...antdJaJP, ...xEnUS },
}

// componentSize does not reach Menu, so its rows get the small height here
const COMPONENTS = { Menu: { itemHeight: 32 } }

export default function App() {
  useSyncExternalStore(listener => store.subscribe(listener), () => store.version)
  const [activeKey, setActiveKey] = useState<string>()
  const [preferences, setPreferences] = useState(loadPreferences)
  const context = useMemo(() => {
    const t: Translate = (key, vars) => translate(preferences.lang, key, vars)
    return { ...preferences, t }
  }, [preferences])
  const { mcps, sessions } = store
  const active = sessions.find(s => sessionKey(s) === activeKey) ?? sessions[0]
  const mcp = mcps.find(m => m.mcp_id === active?.mcp_id)
  const { t, lang, dark } = context

  useEffect(() => connect(store), [])

  const handleChange = (next: Preferences) => {
    setPreferences(next)
    savePreferences(next)
  }

  return (
    <XProvider
      componentSize="small"
      locale={LOCALES[lang]}
      theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, components: COMPONENTS }}
    >
      <PreferencesContext.Provider value={context}>
        <Layout style={{ height: '100vh' }}>
          <PageHeader onChange={handleChange} />
          <Layout.Content style={{ minHeight: 0, background: 'var(--ant-color-bg-container)' }}>
            <Splitter style={{ height: '100%' }}>
              <Splitter.Panel defaultSize={320} min={320} max="60%" style={{ overflow: 'auto' }}>
                <SessionList mcps={mcps} sessions={sessions} activeKey={active && sessionKey(active)} onSelect={setActiveKey} />
              </Splitter.Panel>
              <Splitter.Panel style={{ overflow: 'hidden' }}>
                {active ? (
                  <Tabs
                    style={{ height: '100%', padding: '0 16px' }}
                    styles={{ body: { height: '100%' }, content: { height: '100%' } }}
                    items={[
                      { key: 'conversation', label: t('tabConversation'), children: <Transcript session={active} /> },
                      { key: 'log', label: t('tabProtocolLog'), children: <ProtocolLog session={active} /> },
                      { key: 'info', label: t('tabSession'), children: <SessionInfo session={active} mcp={mcp} /> },
                    ]}
                  />
                ) : (
                  <Empty style={{ marginTop: 120 }} description={t('noSessions')} />
                )}
              </Splitter.Panel>
            </Splitter>
          </Layout.Content>
        </Layout>
      </PreferencesContext.Provider>
    </XProvider>
  )
}
