import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ManagerPage } from './ManagerPage'
import { ChatHandoff } from '../../features/handoff/ChatHandoff'

it('does not expose demo cases or pretend to register a handoff in API mode', () => {
  render(<><ManagerPage caseId="DEMO-1024" demo={false} /><ChatHandoff demo={false} disabled={false} session={{ session_id: 'api-session', messages: [], selected_offer: null, last_turn: null, quotes_enabled: false }} /></>)
  expect(screen.getByRole('heading', { name: 'Очередь ещё не подключена' })).toBeVisible()
  expect(screen.queryByText('DEMO-1024')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Зарегистрировать демообращение' })).toBeNull()
  expect(localStorage.getItem('softline:demo:handoffs:v1')).toBeNull()
})
