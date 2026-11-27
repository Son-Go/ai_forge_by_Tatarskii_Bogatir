import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import type { Offer } from '../../shared/api/types'
import { QuoteDraftAction } from './QuoteDraftAction'
import { approveQuoteDraft, downloadDraft, requestInvoiceDraft, requestQuoteDraft } from './quoteApi'

vi.mock('./quoteApi', () => ({
  approveQuoteDraft: vi.fn(), downloadDraft: vi.fn(), requestInvoiceDraft: vi.fn(), requestQuoteDraft: vi.fn(),
}))

const sessionId = '11111111-1111-4111-8111-111111111111'
const quoteId = '22222222-2222-4222-8222-222222222222'
const nextQuoteId = '33333333-3333-4333-8333-333333333333'
const pdf = new Blob(['%PDF-1.4\n% SYNTHETIC TEST'], { type: 'application/pdf' })
const approveLabel = 'Одобрить КП и получить счёт'
const quote = vi.mocked(requestQuoteDraft)
const approve = vi.mocked(approveQuoteDraft)
const invoice = vi.mocked(requestInvoiceDraft)
const download = vi.mocked(downloadDraft)

beforeEach(() => {
  vi.resetAllMocks()
  quote.mockResolvedValue({ blob: pdf, quoteId, invoicesEnabled: true })
  approve.mockResolvedValue(undefined)
  invoice.mockResolvedValue(pdf)
})

function setup() {
  const onRefresh = vi.fn(), onOfferChanged = vi.fn()
  render(<QuoteDraftAction sessionId={sessionId} demo={false} onRefresh={onRefresh} onOfferChanged={onOfferChanged} />)
  fireEvent.click(screen.getByRole('button', { name: 'Сформировать КП' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Наименование заказчика' }), { target: { value: 'Синтетический заказчик' } })
  return { onRefresh, onOfferChanged }
}

async function createQuote() {
  fireEvent.click(screen.getByRole('button', { name: 'Скачать КП' }))
  await screen.findByRole('button', { name: approveLabel })
}

it('requires an explicit approval after creating the PDF, blocks duplicate approval and reuses the same quote for invoice downloads', async () => {
  let confirm!: () => void
  approve.mockImplementationOnce(() => new Promise<void>((resolve) => { confirm = resolve }))
  setup()
  expect(screen.queryByRole('button', { name: approveLabel })).toBeNull()
  expect(invoice).not.toHaveBeenCalled()
  await createQuote()
  expect(quote).toHaveBeenCalledWith(sessionId, { customer_name: 'Синтетический заказчик', quantity: 1 }, expect.any(AbortSignal))
  expect(download).toHaveBeenCalledWith(pdf, 'quote.pdf')
  expect(approve).not.toHaveBeenCalled()
  expect(invoice).not.toHaveBeenCalled()
  const button = screen.getByRole('button', { name: approveLabel })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(screen.getByRole('textbox', { name: 'Наименование заказчика' })).toBeDisabled()
  expect(approve).toHaveBeenCalledExactlyOnceWith(sessionId, quoteId, expect.any(AbortSignal))
  expect(invoice).not.toHaveBeenCalled()
  await act(async () => confirm())
  const repeat = await screen.findByRole('button', { name: 'Скачать счёт' })
  await waitFor(() => expect(repeat).toBeEnabled())
  expect(invoice).toHaveBeenCalledExactlyOnceWith(sessionId, quoteId, expect.any(AbortSignal))
  fireEvent.click(repeat)
  await waitFor(() => expect(download).toHaveBeenCalledTimes(3))
  expect(invoice).toHaveBeenCalledTimes(2)
  expect(invoice.mock.calls.every((call) => call[0] === sessionId && call[1] === quoteId)).toBe(true)
  expect(approve).toHaveBeenCalledOnce()
})

it('does not request an invoice when approval fails, retains the form and requires explicit retry', async () => {
  approve.mockRejectedValueOnce(new Error('Синтетический сбой одобрения'))
  setup()
  await createQuote()
  fireEvent.click(screen.getByRole('button', { name: approveLabel }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('Синтетический сбой одобрения')
  expect(screen.getByRole('textbox', { name: 'Наименование заказчика' })).toHaveValue('Синтетический заказчик')
  expect(screen.getByRole('spinbutton', { name: 'Количество выбранных позиций' })).toHaveValue(1)
  expect(invoice).not.toHaveBeenCalled()
  expect(approve).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: approveLabel }))
  await waitFor(() => expect(download).toHaveBeenCalledWith(pdf, 'invoice.pdf'))
  expect(approve).toHaveBeenCalledTimes(2)
  expect(invoice).toHaveBeenCalledOnce()
})

it('retains a successful approval when invoice delivery fails and retries only the same invoice', async () => {
  invoice.mockRejectedValueOnce(new Error('Синтетический сбой скачивания'))
  setup()
  await createQuote()
  fireEvent.click(screen.getByRole('button', { name: approveLabel }))
  await screen.findByRole('alert')
  expect(download).toHaveBeenCalledTimes(1)
  expect(approve).toHaveBeenCalledOnce()
  expect(invoice).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: approveLabel })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Скачать счёт' }))
  await waitFor(() => expect(download).toHaveBeenCalledWith(pdf, 'invoice.pdf'))
  expect(invoice).toHaveBeenCalledTimes(2)
  expect(invoice.mock.calls[1]![1]).toBe(quoteId)
  expect(approve).toHaveBeenCalledOnce()
})

it.each(['OFFER_CHANGED', 'QUOTE_SUPERSEDED'] as const)('discards the old quote after %s without repeating a request', async (code) => {
  const updatedOffer: Offer = {
    offer_id: 'synthetic-offer', catalog_version: nextQuoteId, name: 'Обновлённое тестовое предложение',
    product_url: 'https://example.com/product', price: { amount: '12000', currency: 'RUB' },
    availability: 'available', attributes: {}, source_ids: [],
  }
  invoice.mockRejectedValueOnce(new ApiError(409, { code, message: 'Согласуйте новые условия', request_id: 'synthetic-test', ...(code === 'OFFER_CHANGED' ? { updated_offer: updatedOffer } : {}) }))
  const { onOfferChanged } = setup()
  await createQuote()
  fireEvent.click(screen.getByRole('button', { name: approveLabel }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: approveLabel })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Скачать счёт' })).toBeNull()
  expect(quote).toHaveBeenCalledOnce()
  expect(approve).toHaveBeenCalledOnce()
  expect(invoice).toHaveBeenCalledOnce()
  if (code === 'OFFER_CHANGED') expect(onOfferChanged).toHaveBeenCalledExactlyOnceWith(updatedOffer)
  else expect(onOfferChanged).not.toHaveBeenCalled()
  quote.mockResolvedValueOnce({ blob: pdf, quoteId: nextQuoteId, invoicesEnabled: true })
  await createQuote()
  expect(approve).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: approveLabel }))
  await waitFor(() => expect(invoice).toHaveBeenCalledTimes(2))
  expect(approve.mock.calls[1]![1]).toBe(nextQuoteId)
  expect(invoice.mock.calls[1]![1]).toBe(nextQuoteId)
})

it('requires another explicit approval only when the server returns QUOTE_APPROVAL_REQUIRED', async () => {
  invoice.mockRejectedValueOnce(new ApiError(409, { code: 'QUOTE_APPROVAL_REQUIRED', message: 'Одобрите КП', request_id: 'synthetic-test' }))
  setup()
  await createQuote()
  fireEvent.click(screen.getByRole('button', { name: approveLabel }))
  await screen.findByRole('alert')
  expect(approve).toHaveBeenCalledOnce()
  expect(invoice).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Скачать счёт' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: approveLabel }))
  await waitFor(() => expect(download).toHaveBeenCalledWith(pdf, 'invoice.pdf'))
  expect(approve).toHaveBeenCalledTimes(2)
  expect(invoice).toHaveBeenCalledTimes(2)
})

it('does not offer approval or invoice when the server has disabled invoice drafts', async () => {
  quote.mockResolvedValueOnce({ blob: pdf, quoteId, invoicesEnabled: false })
  setup()
  fireEvent.click(screen.getByRole('button', { name: 'Скачать КП' }))
  await waitFor(() => expect(download).toHaveBeenCalledWith(pdf, 'quote.pdf'))
  expect(screen.queryByRole('button', { name: approveLabel })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Скачать счёт' })).toBeNull()
  expect(approve).not.toHaveBeenCalled()
  expect(invoice).not.toHaveBeenCalled()
})
