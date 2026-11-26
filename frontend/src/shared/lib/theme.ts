import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'
const storageKey = 'softline:theme:v1'
const changeEvent = 'softline:theme-change'
const getTheme = (): Theme => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#15141c' : '#f5f6f8')
}

function subscribe(listener: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === storageKey || event.key === null) {
      applyTheme(event.newValue === 'light' ? 'light' : 'dark')
      listener()
    }
  }
  window.addEventListener(changeEvent, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(changeEvent, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getTheme)
  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    try { localStorage.setItem(storageKey, next) } catch { /* The current visit still supports switching. */ }
    window.dispatchEvent(new Event(changeEvent))
  }
  return { theme, toggleTheme }
}
