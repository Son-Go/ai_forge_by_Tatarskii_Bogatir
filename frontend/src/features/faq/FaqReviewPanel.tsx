import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { SourcesList, type DisplaySource } from '../../entities/source/SourcesList'
import { safeUrl } from '../../shared/lib/presentation'
import { Icon } from '../../shared/ui/Icon'
import './faq-review.css'

// Display labels from section 1 of the supplied plan, NOT server enum/DTO values.
export type FaqReviewStatus = 'В очереди' | 'В FAQ' | 'Нужна проверка' | 'Ответ по заказу' | 'Отклонено' | 'Снято с публикации'
export interface FaqReviewPanelProps {
  status?: FaqReviewStatus
  question?: string
  answer?: string
  reason?: string
  source?: DisplaySource
  sourceText?: string
  sourceControls?: (disabled: boolean) => ReactNode
  noCandidate?: boolean
  loading?: boolean
  error?: string
  // Presentation callbacks only: no assumed URL, JSON body or status transition.
  // The future adapter must update status/content from its validated server reply.
  onPublish?: (question: string, answer: string, source: DisplaySource, signal: AbortSignal) => Promise<void>
  onReject?: (signal: AbortSignal) => Promise<void>
  onUnpublish?: (signal: AbortSignal) => Promise<void>
}

const descriptions: Record<FaqReviewStatus, string> = {
  'В очереди': 'Обращение закрыто. Ответ ожидает фоновой проверки.',
  'В FAQ': 'Вопрос и ответ опубликованы в FAQ.',
  'Нужна проверка': 'Проверьте предложенный текст и подтверждающий источник.',
  'Ответ по заказу': 'Текст доступен в истории обращения.',
  'Снято с публикации': 'Ответ исключён из поиска FAQ.',
  'Отклонено': 'Кандидат был отклонён при ручной проверке.',
}

function ReviewEditor({ question, answer, source, pending, publish, reject }: {
  question: string; answer: string; source?: DisplaySource; pending: boolean
  publish?: (question: string, answer: string, source: DisplaySource) => void
  reject?: () => void
}) {
  const id = useId()
  const [editedQuestion, setQuestion] = useState(question)
  const [editedAnswer, setAnswer] = useState(answer)
  const [confirmation, setConfirmation] = useState('')
  const sourceKey = source && safeUrl(source.url)
    ? JSON.stringify([source.id, source.url, source.title, source.checked_at, source.snapshot_at]) : ''
  const confirmed = !!sourceKey && confirmation === sourceKey
  const canPublish = !!publish && !!editedQuestion.trim() && !!editedAnswer.trim() && confirmed
  return <form aria-label="Проверка ответа для FAQ" onSubmit={(event) => {
    event.preventDefault()
    if (canPublish && source && publish) publish(editedQuestion.trim(), editedAnswer.trim(), source)
  }}><fieldset disabled={pending}>
    <legend className="sr-only">Вопрос, ответ и подтверждение источника</legend>
    <label htmlFor={`${id}-question`}>Вопрос для FAQ</label>
    <textarea id={`${id}-question`} rows={2} maxLength={500} required value={editedQuestion} onChange={(event) => { setQuestion(event.target.value); setConfirmation('') }} />
    <label htmlFor={`${id}-answer`}>Ответ для FAQ</label>
    <textarea id={`${id}-answer`} rows={4} maxLength={2000} required value={editedAnswer} onChange={(event) => { setAnswer(event.target.value); setConfirmation('') }} />
    <label className="faq-review-confirm"><input type="checkbox" checked={confirmed} disabled={!sourceKey} onChange={(event) => setConfirmation(event.target.checked ? sourceKey : '')} />
      <span>Подтверждаю, что источник обосновывает исправленный ответ</span></label>
    <div className="faq-review-actions"><button type="submit" className="accent-action" disabled={!canPublish || pending}><Icon name="check" />Опубликовать в FAQ</button>
      <button type="button" disabled={!reject || pending} onClick={reject}>Отклонить</button></div>
  </fieldset></form>
}

export function FaqReviewPanel({ status, question = '', answer = '', reason, source, sourceText, sourceControls, noCandidate, loading = false, error,
  onPublish, onReject, onUnpublish }: FaqReviewPanelProps) {
  const id = useId()
  const [pending, setPending] = useState('')
  const [saveError, setSaveError] = useState('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  async function run(action: (signal: AbortSignal) => Promise<void>, label: string) {
    if (operation.current || loading) return
    const current = new AbortController()
    operation.current = current
    setPending(label); setSaveError('')
    try { await action(current.signal) }
    catch (cause) {
      if (!current.signal.aborted) setSaveError(cause instanceof Error ? cause.message : 'Не удалось сохранить изменения. Повторите запрос.')
    } finally {
      if (operation.current === current) operation.current = null
      if (!current.signal.aborted) setPending('')
    }
  }
  const readable = status === 'В FAQ' || status === 'В очереди'
  return <section className="faq-review case-section" aria-labelledby={`${id}-heading`} aria-busy={!!pending || loading}>
    <div className="faq-review-heading"><h3 id={`${id}-heading`}><Icon name="book" />Ответ для FAQ</h3>
      {status && <span className={`faq-review-status${status === 'В FAQ' ? ' is-published' : status === 'Нужна проверка' ? ' needs-review' : ''}`} role="status" aria-label="Статус проверки FAQ">{status}</span>}
    </div>
    {loading && !status ? <p className="muted" role="status">Загружаем результат проверки…</p>
      : !status ? <p className="muted">{noCandidate ? 'Для этого обращения нет кандидата в FAQ.' : 'Данные проверки FAQ пока недоступны.'}</p> : <>
      <p className="faq-review-description muted">{descriptions[status]}</p>
      {status === 'Нужна проверка' && reason && <p className="faq-review-reason"><Icon name="warning" /><span>{reason}</span></p>}
      {readable && <div className="faq-review-copy">
        {question && <div><h4>Вопрос</h4><p>{question}</p></div>}
        {answer && <div><h4>Ответ</h4><p>{answer}</p></div>}
      </div>}
      {(readable || status === 'Нужна проверка') && (source ? <SourcesList sources={[source]} /> : <p className="faq-review-source-missing muted">Подтверждающий источник не передан.</p>)}
      {status === 'Нужна проверка' && sourceControls?.(!!pending || loading)}
      {status === 'Нужна проверка' && sourceText && <p className="faq-review-operation">{sourceText}</p>}
      {status === 'Нужна проверка' && <ReviewEditor question={question} answer={answer} source={source} pending={!!pending || loading}
        publish={onPublish ? (q, a, s) => { void run((signal) => onPublish(q, a, s, signal), 'Публикуем ответ…') } : undefined}
        reject={onReject ? () => { void run(onReject, 'Отклоняем кандидата…') } : undefined} />}
      {status === 'В FAQ' && <button type="button" className="quiet-action" disabled={!onUnpublish || !!pending || loading} onClick={() => { if (onUnpublish) void run(onUnpublish, 'Снимаем с публикации…') }}>Снять с публикации</button>}
    </>}
    {loading && status && <p className="faq-review-operation muted" role="status">Обновляем результат проверки…</p>}
    {pending && <p className="faq-review-operation muted" role="status">{pending}</p>}
    {(saveError || error) && <p className="faq-review-error" role="alert">{saveError || error} {status === 'Нужна проверка' ? 'Введённый текст сохранён; можно повторить действие.' : 'Можно повторить действие.'}</p>}
  </section>
}
