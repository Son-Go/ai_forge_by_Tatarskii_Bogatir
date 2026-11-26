import { render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { CaseTimeline } from './CaseTimeline'
import { demoCases } from '../../features/handoff/fixtures'

it('orders only available messages without mutating the synthetic fixture or offering actions', () => {
  const record = demoCases.find((item) => item.status === 'resolved')!
  const original = structuredClone(record)
  render(<CaseTimeline messages={[...record.messages].reverse()} />)
  const timeline = screen.getByRole('list', { name: 'Хронология обращения' })
  expect(within(timeline).getAllByRole('listitem')).toHaveLength(record.messages.length)
  const dates = [...timeline.querySelectorAll('time')].map((time) => time.dateTime)
  expect(dates).toEqual([...dates].sort())
  expect(within(timeline).queryByText('Действие менеджера')).toBeNull()
  expect(within(timeline).queryByText('Документ')).toBeNull()
  expect(within(timeline).queryByRole('button')).toBeNull()
  expect(record).toEqual(original)
})

it('keeps an empty history explicit', () => {
  render(<CaseTimeline messages={[]} />)
  expect(screen.getByText('История пока пуста.')).toBeVisible()
})
