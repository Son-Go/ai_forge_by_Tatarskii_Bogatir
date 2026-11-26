import type { components } from '../../shared/api/schema'
import { requireOk } from '../../shared/api/client'

export type QuoteDraftInput = components['schemas']['QuoteRequest']

export async function requestQuoteDraft(sessionId: string, input: QuoteDraftInput, signal: AbortSignal): Promise<Blob> {
  if (!input.customer_name.trim() || input.customer_name.trim().length > 160) throw new Error('Укажите наименование заказчика до 160 символов.')
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 99999) throw new Error('Количество позиций должно быть целым числом от 1 до 99999.')
  const response = await requireOk(await fetch(new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/quote-drafts`, window.location.origin), {
    method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/pdf', 'Content-Type': 'application/json' },
    // quantity is the number of selected catalog positions, never license seats.
    body: JSON.stringify({ customer_name: input.customer_name.trim(), quantity: input.quantity }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  }))
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/pdf') throw new Error('Сервис не вернул PDF. Черновик не скачан.')
  const blob = await response.blob()
  if (await blob.slice(0, 5).text() !== '%PDF-') throw new Error('Получен некорректный PDF. Черновик не скачан.')
  return blob
}

export function downloadQuoteDraft(blob: Blob, demo: boolean) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = demo ? 'DEMO-softline-quote-draft.pdf' : 'softline-quote-draft.pdf'
  document.body.append(link)
  link.click()
  link.remove()
  // Keep the blob alive long enough for the browser to initiate the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
