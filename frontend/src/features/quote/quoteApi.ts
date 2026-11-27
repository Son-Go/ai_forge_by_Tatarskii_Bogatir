import type { components } from '../../shared/api/schema'
import { requireOk } from '../../shared/api/client'

export type QuoteDraftInput = components['schemas']['QuoteRequest']

export async function requestQuoteDraft(sessionId: string, input: QuoteDraftInput, signal: AbortSignal) {
  if (!input.customer_name.trim() || input.customer_name.trim().length > 160) throw new Error('Укажите наименование заказчика до 160 символов.')
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 99999) throw new Error('Количество позиций должно быть целым числом от 1 до 99999.')
  const response = await postDocument(sessionId, '/quote-drafts', signal, { customer_name: input.customer_name.trim(), quantity: input.quantity })
  const quoteId = response.headers.get('X-Quote-Id')
  const invoicesEnabled = response.headers.get('X-Invoice-Drafts-Enabled') === 'true'
  if (invoicesEnabled && !quoteId) throw new Error('Сервис не вернул номер версии коммерческого предложения.')
  return { blob: await readPdf(response), quoteId, invoicesEnabled }
}

export async function approveQuoteDraft(sessionId: string, quoteId: string, signal: AbortSignal) {
  await postDocument(sessionId, `/quote-drafts/${encodeURIComponent(quoteId)}/approval`, signal)
}

export async function requestInvoiceDraft(sessionId: string, quoteId: string, signal: AbortSignal) {
  const input: components['schemas']['InvoiceDraftRequest'] = { quote_id: quoteId }
  const response = await postDocument(sessionId, '/invoice-drafts', signal, input)
  return { blob: await readPdf(response), testPayment: response.headers.get('X-Invoice-Purpose') === 'test_payment' }
}

async function postDocument(sessionId: string, path: string, signal: AbortSignal, body?: QuoteDraftInput | components['schemas']['InvoiceDraftRequest']) {
  return requireOk(await fetch(new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}${path}`, window.location.origin), {
    method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/pdf', ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  }))
}

async function readPdf(response: Response) {
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') throw new Error('Сервис не вернул PDF. Документ не скачан.')
  const blob = await response.blob()
  if (await blob.slice(0, 5).text() !== '%PDF-') throw new Error('Получен некорректный PDF. Документ не скачан.')
  return blob
}

export function downloadDraft(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  // Keep the blob alive long enough for the browser to initiate the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
