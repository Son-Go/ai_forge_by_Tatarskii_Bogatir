import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ManagerPage } from './ManagerPage'

it('does not expose demo cases or pretend to register a handoff in API mode', () => {
  render(<ManagerPage caseId="DEMO-1024" demo={false} />)
  expect(screen.getByRole('heading', { name: 'Доступ менеджера' })).toBeVisible()
  expect(screen.queryByText('DEMO-1024')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Зарегистрировать демообращение' })).toBeNull()
  expect(localStorage.getItem('softline:demo:handoffs:v1')).toBeNull()
})
