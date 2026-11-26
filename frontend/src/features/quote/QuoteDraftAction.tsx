import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../shared/api/client'
import { Icon } from '../../shared/ui/Icon'
import { downloadQuoteDraft, requestQuoteDraft } from './quoteApi'

export function QuoteDraftAction({ sessionId, demo, onRefresh }: { sessionId: string; demo: boolean; onRefresh: () => void }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  async function create() {
    if (operation.current) return
    const current = new AbortController()
    operation.current = current
    setStatus('loading')
    try {
      const blob = await requestQuoteDraft(sessionId, current.signal)
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
    <button type="button" className="quiet-action" onClick={() => void create()} disabled={status === 'loading'}><Icon name="download" />{status === 'loading' ? 'Подготавливаем PDF…' : demo ? 'Скачать демочерновик КП' : 'Скачать черновик КП'}</button>
    {demo && <p className="muted">Тестовый PDF без коммерческой силы и реквизитов. Это не счёт.</p>}
    {status === 'done' && <p className="document-status" role="status">Черновик подготовлен. Скачивание начато; документ требует проверки менеджером.</p>}
    {status === 'error' && <div className="document-error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh}>Обновить состояние</button></div>}
  </section>
}
