import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { InvoiceDemo } from './InvoiceDemo'

afterEach(() => vi.restoreAllMocks())
it('previews synthetic values without sending requests, calculating tax or producing a document', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  render(<InvoiceDemo />)
  fireEvent.click(screen.getByText('Счёт · демонстрация'))
  fireEvent.change(screen.getByLabelText('Заказчик · демо'), { target: { value: 'Синтетическая организация' } })
  fireEvent.submit(screen.getByRole('form', { name: 'Демонстрация формы счёта' }))
  expect(screen.getByRole('status')).toHaveTextContent('Синтетическая организация')
  expect(screen.getByRole('status')).toHaveTextContent('Это не платёжный документ')
  expect(screen.queryByRole('link')).toBeNull()
  expect(fetchSpy).not.toHaveBeenCalled()
})
