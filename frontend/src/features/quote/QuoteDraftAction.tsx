import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '../../shared/api/client'
import { Icon } from '../../shared/ui/Icon'
import { downloadQuoteDraft, requestQuoteDraft } from './quoteApi'

export function QuoteDraftAction({ sessionId, demo, onRefresh }: { sessionId: string; demo: boolean; onRefresh: () => void }) {
  const [open, setOpen] = useState(false)
  const [customer, setCustomer] = useState('')
  const [quantity, setQuantity] = useState('1')
  const formId = useId()
  const customerInput = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => { if (open) customerInput.current?.focus() }, [open])
  async function create() {
    if (operation.current) return
    const current = new AbortController()
    operation.current = current
    setStatus('loading')
    try {
      const blob = await requestQuoteDraft(sessionId, { customer_name: customer, quantity: Number(quantity) }, current.signal)
      if (current.signal.aborted) return
      downloadQuoteDraft(blob, demo)
      setStatus('done')
    } catch (cause) {
      if (current.signal.aborted) return
      setError(cause instanceof ApiError && cause.body.code === 'OFFER_CHANGED'
        ? 'Предложение изменилось. Обновите состояние и подтвердите актуальный выбор перед формированием КП.'
        : cause instanceof Error ? cause.message : 'Не удалось подготовить черновик. Проверьте состояние перед повтором.')
      setStatus('error')
    } finally { if (operation.current === current) operation.current = null }
  }
  return <section className="quote-draft" aria-label="Черновик коммерческого предложения">
    <button type="button" className="quiet-action" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={formId} disabled={status === 'loading'}><Icon name="file" />{demo ? 'Подготовить демочерновик КП' : 'Подготовить черновик КП'}</button>
    {open && <form className="quote-form" id={formId} aria-label="Параметры коммерческого предложения" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <label htmlFor={`${formId}-customer`}>Наименование заказчика</label>
      <input ref={customerInput} id={`${formId}-customer`} name="customer_name" autoComplete="organization" maxLength={160} required value={customer} disabled={status === 'loading'} onChange={(event) => setCustomer(event.target.value)} />
      <label htmlFor={`${formId}-quantity`}>Количество выбранных позиций</label>
      <input id={`${formId}-quantity`} name="quantity" type="number" min="1" max="99999" step="1" required value={quantity} disabled={status === 'loading'} aria-describedby={`${formId}-quantity-help`} onChange={(event) => setQuantity(event.target.value)} />
      <p id={`${formId}-quantity-help`} className="muted">Количество позиций, а не пользователей в лицензии. Например, одна лицензия на 50 пользователей — одна позиция.</p>
      <button type="submit" className="accent-action" disabled={status === 'loading' || !customer.trim() || !Number.isSafeInteger(Number(quantity)) || Number(quantity) < 1 || Number(quantity) > 99999 || customer.trim().length > 160}><Icon name="download" />{status === 'loading' ? 'Подготавливаем PDF…' : demo ? 'Скачать демочерновик КП' : 'Скачать черновик КП'}</button>
    </form>}
    {demo && <p className="muted">Тестовый PDF без коммерческой силы и реквизитов. Это не счёт.</p>}
    {status === 'done' && <p className="document-status" role="status">Черновик подготовлен. Скачивание начато; документ требует проверки менеджером.</p>}
    {status === 'error' && <div className="document-error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh}>Обновить состояние</button></div>}
  </section>
}
