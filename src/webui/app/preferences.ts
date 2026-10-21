import { createContext, useContext } from 'react'
import { isLang, translate } from './i18n'
import type { Lang, Translate } from './i18n'

export interface Preferences {
  lang: Lang
  dark: boolean
}

export interface PreferencesContextValue extends Preferences {
  t: Translate
}

const STORAGE_KEY = 'subagent-cockpit-webui'

/** Browser language -> UI language: Traditional for zh-TW / zh-HK / zh-MO / zh-Hant, Simplified for other Chinese. */
function browserLang(): Lang {
  const language = navigator.language.toLowerCase()
  if (/^zh-(tw|hk|mo|hant)/.test(language)) return 'zh-TW'
  if (language.startsWith('zh')) return 'zh-CN'
  return language.startsWith('ja') ? 'ja' : 'en'
}

/** First visit follows the browser's language and the system color scheme. */
function defaults(): Preferences {
  return { lang: browserLang(), dark: window.matchMedia('(prefers-color-scheme: dark)').matches }
}

/** The viewer's last choice, kept in this browser only; unreadable storage falls back to the defaults. */
export function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    return { ...defaults(), ...(isLang(String(saved?.lang)) ? { lang: saved.lang } : {}), ...(typeof saved?.dark === 'boolean' ? { dark: saved.dark } : {}) }
  } catch (error) {
    console.warn('webui: cannot read saved preferences', error)
    return defaults()
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch (error) {
    console.warn('webui: cannot save preferences', error)
  }
}

export const PreferencesContext = createContext<PreferencesContextValue>({
  lang: 'en',
  dark: false,
  t: (key, vars) => translate('en', key, vars),
})

export const usePreferences = () => useContext(PreferencesContext)
