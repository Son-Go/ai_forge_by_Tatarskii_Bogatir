import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '../../shared/api/client'
import type { Offer } from '../../shared/api/types'
import { Icon } from '../../shared/ui/Icon'
import { approveQuoteDraft, downloadDraft, requestInvoiceDraft, requestQuoteDraft } from './quoteApi'

export function QuoteDraftAction({ sessionId, demo, onRefresh, onOfferChanged }: {
  sessionId: string; demo: boolean; onRefresh: () => void; onOfferChanged: (offer?: Offer) => void
}) {
  const [open, setOpen] = useState(false)
  const [customer, setCustomer] = useState('')
  const [quantity, setQuantity] = useState('1')
  const formId = useId()
  const customerInput = useRef<HTMLInputElement>(null)
  const [quote, setQuote] = useState<{ id: string; approved: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => { if (open) customerInput.current?.focus() }, [open])
  function clearDocument() { setQuote(null); setNotice(''); setError('') }
  async function run(task: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return
    const current = new AbortController()
    operation.current = current
    setBusy(true)
    setError('')
    try {
      await task(current.signal)
    } catch (cause) {
      if (current.signal.aborted) return
      setNotice('')
      if (cause instanceof ApiError && ['OFFER_CHANGED', 'QUOTE_SUPERSEDED', 'QUOTE_NOT_FOUND'].includes(cause.body.code)) setQuote(null)
      if (cause instanceof ApiError && cause.body.code === 'QUOTE_APPROVAL_REQUIRED') setQuote((current) => current && { ...current, approved: false })
      if (cause instanceof ApiError && cause.body.code === 'OFFER_CHANGED') onOfferChanged(cause.body.updated_offer)
      setError(cause instanceof ApiError && cause.body.code === 'OFFER_CHANGED'
        ? 'Предложение изменилось. Подтвердите актуальную карточку, затем сформируйте и одобрите новое КП.'
        : cause instanceof Error ? cause.message : 'Не удалось подготовить документ. Попробуйте ещё раз.')
    } finally {
      if (operation.current === current) operation.current = null
      if (!current.signal.aborted) setBusy(false)
    }
  }
  function create() {
    clearDocument()
    void run(async (signal) => {
      const result = await requestQuoteDraft(sessionId, { customer_name: customer, quantity: Number(quantity) }, signal)
      if (signal.aborted) return
      const canApprove = result.invoicesEnabled && result.quoteId
      downloadDraft(result.blob, demo ? 'DEMO-quote.pdf' : 'quote.pdf')
      if (canApprove) setQuote({ id: canApprove, approved: false })
      setNotice(canApprove ? 'Скачивание начато. Откройте PDF и проверьте условия перед одобрением.'
        : 'КП подготовлено. Скачивание начато.')
    })
  }
  async function downloadInvoice(quoteId: string, signal: AbortSignal) {
    const pdf = await requestInvoiceDraft(sessionId, quoteId, signal)
    if (signal.aborted) return
    downloadDraft(pdf, demo ? 'DEMO-invoice.pdf' : 'invoice.pdf')
    setNotice('Скачивание счёта начато.')
  }
  return <section className="quote-draft" aria-label="Коммерческое предложение">
    <button type="button" className="quiet-action" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={formId} disabled={busy}><Icon name="file" />Сформировать КП</button>
    {open && <form className="quote-form" id={formId} aria-label="Параметры коммерческого предложения" onSubmit={(event) => { event.preventDefault(); create() }}>
      <label htmlFor={`${formId}-customer`}>Наименование заказчика</label>
      <input ref={customerInput} id={`${formId}-customer`} name="customer_name" autoComplete="organization" maxLength={160} required value={customer} disabled={busy} onChange={(event) => { setCustomer(event.target.value); clearDocument() }} />
      <label htmlFor={`${formId}-quantity`}>Количество выбранных позиций</label>
      <input id={`${formId}-quantity`} name="quantity" type="number" min="1" max="99999" step="1" required value={quantity} disabled={busy} aria-describedby={`${formId}-quantity-help`} onChange={(event) => { setQuantity(event.target.value); clearDocument() }} />
      <p id={`${formId}-quantity-help`} className="muted">Количество позиций, а не пользователей в лицензии. Например, одна лицензия на 50 пользователей — одна позиция.</p>
      <button type="submit" className="accent-action" disabled={busy || !customer.trim() || !Number.isSafeInteger(Number(quantity)) || Number(quantity) < 1 || Number(quantity) > 99999 || customer.trim().length > 160}><Icon name="download" />Скачать КП</button>
    </form>}
    {demo && <p className="muted">Тестовые PDF для проверки процесса согласования.</p>}
    {busy && <p className="document-status" role="status">Обрабатываем запрос…</p>}
    {!busy && notice && <p className="document-status" role="status">{notice}</p>}
    {quote && <div className="quote-approval">
      {quote.approved
        ? <button type="button" className="accent-action" disabled={busy} onClick={() => void run((signal) => downloadInvoice(quote.id, signal))}>
          <Icon name="download" />Скачать счёт</button>
        : <button type="button" className="quiet-action" disabled={busy} onClick={() => void run(async (signal) => {
          await approveQuoteDraft(sessionId, quote.id, signal)
          if (signal.aborted) return
          setQuote({ ...quote, approved: true })
          await downloadInvoice(quote.id, signal)
        })}>Одобрить КП и получить счёт</button>}
    </div>}
    {error && <div className="document-error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh}>Обновить состояние</button></div>}
  </section>
}
