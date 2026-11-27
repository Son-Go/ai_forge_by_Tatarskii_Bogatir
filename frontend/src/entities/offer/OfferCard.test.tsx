import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { Offer } from '../../shared/api/types'
import { OfferCard } from './OfferCard'

const card: Offer = { offer_id: 'synthetic-offer', catalog_version: '11111111-1111-4111-8111-111111111111', name: 'Синтетическая лицензия', product_url: 'https://example.com/product', price: { amount: '12000', currency: 'RUB' }, availability: 'unavailable', attributes: {}, source_ids: [] }

it('displays the feed status and price, but uses the explicit server permission for selection', () => {
  const select = vi.fn()
  const { rerender } = render(<OfferCard offer={{ ...card, selectable: false }} onSelect={select} />)
  expect(screen.getByText('12 000 ₽', { exact: false })).toBeVisible()
  expect(screen.getByText('Нет в наличии по данным фида')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Выбрать' })).toBeDisabled()
  rerender(<OfferCard offer={{ ...card, selectable: true }} onSelect={select} />)
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать' }))
  expect(select).toHaveBeenCalledExactlyOnceWith({ ...card, selectable: true })
  expect(screen.getByText(/Статус фида не обещает срок поставки/)).toBeVisible()
  rerender(<OfferCard offer={{ ...card, availability: 'available', selectable: false }} onSelect={select} />)
  expect(screen.getByRole('button', { name: 'Выбрать' })).toBeDisabled()
})

it('keeps historical cards readable but blocks selection without explicit server permission', () => {
  const select = vi.fn()
  render(<OfferCard offer={{ ...card, price: null, availability: 'unknown' }} onSelect={select} />)
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать' }))
  expect(select).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Выбрать' })).toBeDisabled()
  expect(screen.getByText('Цена требует уточнения')).toBeVisible()
})

it('never permits a disabled or already selected card and keeps manager cards read-only', () => {
  const select = vi.fn()
  const { rerender } = render(<OfferCard offer={{ ...card, selectable: true }} disabled onSelect={select} />)
  expect(screen.getByRole('button', { name: 'Выбрать' })).toBeDisabled()
  rerender(<OfferCard offer={{ ...card, selectable: true }} selected onSelect={select} />)
  expect(screen.getByRole('button', { name: 'Выбрано' })).toBeDisabled()
  rerender(<OfferCard offer={{ ...card, selectable: true }} readOnly onSelect={select} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(select).not.toHaveBeenCalled()
})
