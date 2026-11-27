import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { FaqReviewPanel, type FaqReviewPanelProps, type FaqReviewStatus } from './FaqReviewPanel'
import type { Source } from '../../shared/api/types'

const source: Source = { id: 'synthetic-reference', title: 'Тестовая справка об условиях покупки', kind: 'knowledge', url: 'https://example.com/help', checked_at: '2026-11-27T10:00:00Z' }
const review: FaqReviewPanelProps = { status: 'Нужна проверка', question: 'Как получить документ?', answer: 'Документ доступен после проверки.', reason: 'Тестовая причина: ответ неполный.', source }
const confirm = () => fireEvent.click(screen.getByRole('checkbox'))

it.each<FaqReviewStatus>(['В очереди', 'В FAQ', 'Нужна проверка', 'Ответ по заказу', 'Отклонено'])('shows the document display state %s without fabricating actions', (status) => {
  render(<FaqReviewPanel {...review} status={status} />)
  expect(screen.getByRole('heading', { name: 'Ответ для FAQ' })).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent(status)
  for (const button of screen.queryAllByRole('button')) expect(button).toBeDisabled()
})

it('never infers queued from a closed handoff or manufactures a candidate', () => {
  render(<FaqReviewPanel />)
  expect(screen.getByText('Данные проверки FAQ пока недоступны.')).toBeVisible()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})

it('initializes an editor when data arrives and keeps drafts through a failed save and explicit retry', async () => {
  let reject!: (error: Error) => void
  const publish = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail })).mockResolvedValueOnce(undefined)
  const { rerender } = render(<FaqReviewPanel loading />)
  rerender(<FaqReviewPanel {...review} onPublish={publish} />)
  const question = screen.getByRole('textbox', { name: 'Вопрос для FAQ' })
  const answer = screen.getByRole('textbox', { name: 'Ответ для FAQ' })
  expect(question).toHaveValue(review.question)
  fireEvent.change(question, { target: { value: 'Исправленный вопрос' } })
  fireEvent.change(answer, { target: { value: 'Исправленный ответ' } })
  expect(screen.getByRole('button', { name: 'Опубликовать в FAQ' })).toBeDisabled()
  confirm()
  fireEvent.submit(screen.getByRole('form'))
  fireEvent.submit(screen.getByRole('form'))
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish.mock.calls[0]!.slice(0, 3)).toEqual(['Исправленный вопрос', 'Исправленный ответ', source])
  expect(question).toBeDisabled()
  await act(async () => reject(new Error('Тестовый сетевой сбой')))
  expect(screen.getByRole('alert')).toHaveTextContent('Тестовый сетевой сбой')
  expect(question).toHaveValue('Исправленный вопрос')
  expect(answer).toHaveValue('Исправленный ответ')
  expect(question).toBeEnabled()
  fireEvent.submit(screen.getByRole('form'))
  await act(async () => undefined)
  expect(publish).toHaveBeenCalledTimes(2)
  // The component cannot guess a successful server transition from a resolved promise.
  expect(screen.getByRole('status')).toHaveTextContent('Нужна проверка')
  rerender(<FaqReviewPanel status="В FAQ" question="Ответ сервера: вопрос" answer="Ответ сервера: текст" source={source} />)
  expect(screen.getByText('Ответ сервера: текст')).toBeVisible()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('requires renewed confirmation after editing or receiving an updated source', () => {
  const publish = vi.fn()
  const { rerender } = render(<FaqReviewPanel {...review} onPublish={publish} />)
  confirm()
  expect(screen.getByRole('button', { name: 'Опубликовать в FAQ' })).toBeEnabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Ответ для FAQ' }), { target: { value: 'Новый ответ' } })
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  confirm()
  rerender(<FaqReviewPanel {...review} onPublish={publish} source={{ ...source, checked_at: '2026-11-27T11:00:00Z' }} />)
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('textbox', { name: 'Ответ для FAQ' })).toHaveValue('Новый ответ')
})

it('rejects without requiring an edited answer or a source and waits for authoritative props', async () => {
  const reject = vi.fn().mockResolvedValue(undefined)
  const { rerender } = render(<FaqReviewPanel status="Нужна проверка" onReject={reject} />)
  expect(screen.getByRole('checkbox')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }))
  await act(async () => undefined)
  expect(reject).toHaveBeenCalledOnce()
  expect(screen.getByRole('status')).toHaveTextContent('Нужна проверка')
  rerender(<FaqReviewPanel status="Отклонено" />)
  expect(screen.getByRole('status')).toHaveTextContent('Отклонено')
})

it('can unpublish with the same async safeguards and aborts an unfinished action on unmount', async () => {
  let signal: AbortSignal | undefined
  const unpublish = vi.fn((input: AbortSignal) => { signal = input; return new Promise<void>(() => undefined) })
  const { unmount } = render(<FaqReviewPanel status="В FAQ" question="Вопрос" answer="Ответ" source={source} onUnpublish={unpublish} />)
  fireEvent.click(screen.getByRole('button', { name: 'Снять с публикации' }))
  expect(screen.getByRole('button', { name: 'Снять с публикации' })).toBeDisabled()
  expect(unpublish).toHaveBeenCalledOnce()
  unmount()
  expect(signal?.aborted).toBe(true)
})

it('keeps unsafe source URLs unclickable and prevents publication', () => {
  render(<FaqReviewPanel {...review} source={{ ...source, url: 'javascript:alert(1)' }} onPublish={vi.fn()} />)
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Опубликовать в FAQ' })).toBeDisabled()
})

it('does not submit whitespace-only text and disables publication withdrawal while refreshing', () => {
  const publish = vi.fn(), unpublish = vi.fn()
  const { rerender } = render(<FaqReviewPanel {...review} onPublish={publish} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Вопрос для FAQ' }), { target: { value: '  \n ' } })
  confirm()
  fireEvent.submit(screen.getByRole('form'))
  expect(publish).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Опубликовать в FAQ' })).toBeDisabled()
  rerender(<FaqReviewPanel status="В FAQ" loading onUnpublish={unpublish} />)
  expect(screen.getByRole('button', { name: 'Снять с публикации' })).toBeDisabled()
  expect(unpublish).not.toHaveBeenCalled()
})
