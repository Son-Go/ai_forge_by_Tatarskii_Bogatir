import { fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceHeader } from '../ui/WorkspaceHeader'

afterEach(() => { vi.restoreAllMocks(); document.documentElement.dataset.theme = 'dark' })

it('switches the palette and official logo and persists only the preference', () => {
  document.documentElement.dataset.theme = 'dark'
  render(<WorkspaceHeader />)
  expect(screen.getByRole('img').getAttribute('src')).toContain('-white.svg')
  fireEvent.click(screen.getByRole('button', { name: 'Включить светлую тему' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(localStorage.getItem('softline:theme:v1')).toBe('light')
  expect(screen.getByRole('img').getAttribute('src')).toContain('softline-solutions-sofl.png')
  fireEvent.click(screen.getByRole('button', { name: 'Включить тёмную тему' }))
  expect(document.documentElement.dataset.theme).toBe('dark')
})

it('supports blocked storage and updates from another tab', () => {
  document.documentElement.dataset.theme = 'dark'
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied') })
  render(<WorkspaceHeader />)
  fireEvent.click(screen.getByRole('button', { name: 'Включить светлую тему' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'softline:theme:v1', newValue: 'dark' })) })
  expect(screen.getByRole('button', { name: 'Включить светлую тему' })).toBeVisible()
})
