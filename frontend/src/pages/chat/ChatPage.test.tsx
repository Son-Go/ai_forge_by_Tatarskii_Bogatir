import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { ChatPage, ChatView } from './ChatPage'
import { ChatController } from '../../features/chat/model/ChatController'
import { initialState } from '../../features/chat/model/chatReducer'
import { browserStorage } from '../../features/chat/lib/sessionStorage'
import { chatApi } from '../../shared/api/chatApi'

it('works through the same HTTP/SSE client in React StrictMode', async () => {
  const user = userEvent.setup()
  render(<StrictMode><ChatPage /></StrictMode>)
  await screen.findByRole('heading', { name: /Поможем найти/ })
  await user.click(screen.getByRole('button', { name: 'Подобрать решение' }))
  await user.click(screen.getByRole('button', { name: /Отправить/ }))
  await screen.findByRole('button', { name: 'Выбрать' })
  expect(screen.getAllByRole('article', { name: 'Вы' })).toHaveLength(1)
})

it('renders model output as text and never creates unsafe source links', () => {
  const controller = new ChatController(chatApi, browserStorage('test'))
  const { container } = render(<ChatView controller={controller} state={{ ...initialState, phase: 'ready', session: {
    session_id: crypto.randomUUID(), selected_offer: null, last_turn: null, quotes_enabled: false,
    messages: [{ id: crypto.randomUUID(), role: 'assistant', text: '<img src=x onerror=alert(1)>', status: 'complete', created_at: new Date().toISOString(),
      cards: [], sources: [{ id: 'unsafe', title: 'Источник', kind: 'knowledge', url: 'javascript:alert(1)', checked_at: new Date().toISOString() }] }],
  } }} />)
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible()
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
})
