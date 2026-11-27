import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../shared/api/client'
import { handoffApi, type FaqCandidate, type FaqReview } from '../../shared/api/handoffApi'
import { safeUrl } from '../../shared/lib/presentation'
import { FaqReviewPanel, type FaqReviewStatus } from './FaqReviewPanel'

const labels: Record<FaqCandidate['status'], FaqReviewStatus> = {
  queued: 'В очереди', published: 'В FAQ', needs_review: 'Нужна проверка',
  case_specific: 'Ответ по заказу', rejected: 'Отклонено', unpublished: 'Снято с публикации',
}
const reasons: Record<string, string> = {
  ambiguous_pair: 'В обращении несколько вопросов или ответов.',
  review_unavailable: 'Фоновая проверка не завершилась. Проверьте ответ вручную.',
  insufficient_evidence: 'Справка пока не подтверждает ответ.',
  incomplete_answer: 'Ответ нужно дополнить.',
  unsafe_content: 'Проверьте, что ответ не раскрывает данные клиента и подходит для общего использования.',
  stale_source: 'Выдержка устарела. Найдите актуальный источник.',
  duplicate_question: 'Для этого вопроса уже опубликован ответ.',
}

export function FaqReviewConnected({ token, handoffId, onUnauthorized }: {
  token: string; handoffId: string; onUnauthorized: () => void
}) {
  const [review, setReview] = useState<FaqReview>()
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{ query: string; revision: number }>({ query: '', revision: 0 })
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [product, setProduct] = useState('')
  const [edition, setEdition] = useState('')
  const logout = useRef(onUnauthorized)
  useEffect(() => { logout.current = onUnauthorized }, [onUnauthorized])

  useEffect(() => {
    const request = new AbortController()
    let timer = 0
    async function load() {
      setLoading(true)
      try {
        const result = await handoffApi.readFaq(token, handoffId, request.signal, search.query)
        if (request.signal.aborted) return
        setReview(result); setError('')
        if (result.candidate?.status === 'queued') timer = window.setTimeout(() => void load(), 5000)
      } catch (cause) {
        if (request.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) { logout.current(); return }
        if (cause instanceof ApiError && cause.status === 404) setReview(undefined)
        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить результат проверки.')
      } finally {
        if (!request.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => { request.abort(); window.clearTimeout(timer) }
  }, [token, handoffId, search])

  async function save(operation: Promise<FaqReview>, signal: AbortSignal) {
    try {
      const updated = await operation
      if (!signal.aborted) { setReview(updated); setError(''); setSelected('') }
    } catch (cause) {
      if (!signal.aborted && cause instanceof ApiError && cause.status === 401) logout.current()
      throw cause
    }
  }

  const candidate = review?.candidate
  const sources = candidate?.sources.filter((item) => safeUrl(item.url)) ?? []
  const editing = candidate?.status === 'needs_review'
  const source = sources.find((item) => item.id === (editing && selected ? selected : candidate?.source_id))
  const reason = candidate?.reason_code ? reasons[candidate.reason_code] : undefined
  const scopeValid = !edition.trim() || !!product.trim()
  return <>
    <FaqReviewPanel status={candidate ? labels[candidate.status] : undefined} question={candidate?.question ?? undefined}
      answer={candidate?.answer ?? undefined} reason={reason} loading={loading} error={error} noCandidate={review?.candidate === null}
      source={source && { id: source.id, kind: 'knowledge', title: source.title, url: source.url }} sourceText={source?.text}
      sourceControls={(disabled) => <form className="faq-review-source-controls" aria-label="Источники для FAQ" onSubmit={(event) => {
      event.preventDefault()
      setSelected('')
      setSearch((previous) => ({ query: query.trim(), revision: previous.revision + 1 }))
    }}><fieldset disabled={disabled}>
      <label>Поиск по справке <input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} /></label>
      <button type="submit" disabled={loading || !query.trim()}>Найти источник</button>
      {sources.length > 0 && <label>Источник для FAQ <select value={source?.id ?? ''} onChange={(event) => setSelected(event.target.value)}>
        <option value="" disabled>Выберите выдержку</option>
        {sources.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.text.slice(0, 65)}</option>)}
      </select></label>}
      <label>Продукт <input value={product} maxLength={120} onChange={(event) => setProduct(event.target.value)} /></label>
      <label>Редакция <input value={edition} maxLength={120} disabled={!product.trim()} onChange={(event) => setEdition(event.target.value)} /></label>
    </fieldset></form>}
      onPublish={editing && scopeValid ? (question, answer, evidence, signal) => save(handoffApi.approveFaq(token, handoffId, {
        question, answer, source_id: evidence.id,
        ...(product.trim() ? { product: product.trim() } : {}), ...(edition.trim() ? { edition: edition.trim() } : {}),
      }, signal), signal) : undefined}
      onReject={editing ? (signal) => save(handoffApi.rejectFaq(token, handoffId, signal), signal) : undefined}
      onUnpublish={candidate?.status === 'published' ? (signal) => save(handoffApi.unpublishFaq(token, handoffId, signal), signal) : undefined} />
    {error && !editing && <button type="button" className="quiet-action" onClick={() => setSearch((previous) => ({ ...previous, revision: previous.revision + 1 }))}>Повторить загрузку FAQ</button>}
  </>
}
