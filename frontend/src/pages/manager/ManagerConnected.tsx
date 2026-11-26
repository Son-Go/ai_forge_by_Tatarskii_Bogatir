import { useEffect, useRef, useState } from 'react'
import { handoffReasons, type HandoffCase } from '../../entities/handoff/types'
import { handoffApi, type AssignedHandoff, type ManagerReplyInput, type QueueItem } from '../../shared/api/handoffApi'
import { ApiError } from '../../shared/api/client'
import { CaseDetail, ManagerWorkspace } from './ManagerWorkspace'
import { Icon } from '../../shared/ui/Icon'

function presentation(item: QueueItem, messages: AssignedHandoff['messages'] = []): HandoffCase {
  return { id: item.handoff_id, sessionId: item.session_id, title: handoffReasons[item.reason], reason: item.reason,
    status: item.status, createdAt: item.created_at, explanation: item.reason === 'document_review' ? 'Обращение передано для проверки документов.' : 'Обращение передано для заказа вне каталога.',
    requirements: [], messages,
    offers: [...new Map(messages.flatMap((message) => message.cards).map((offer) => [`${offer.offer_id}:${offer.catalog_version}`, offer])).values()],
    sources: [...new Map(messages.flatMap((message) => message.sources).map((source) => [source.id, source])).values()],
  }
}
function ReplyForm({ busy, send }: { busy: boolean; send: (input: ManagerReplyInput) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const pending = useRef<ManagerReplyInput | null>(null)
  return <form className="manager-reply" aria-label="Ответ менеджера" onSubmit={(event) => {
    event.preventDefault()
    if (busy || !text.trim() || text.trim().length > 4000) return
    // Preserve the key after uncertain delivery. An explicit retry of the same
    // text must not duplicate a message already saved by the server.
    const input = pending.current?.text === text.trim() ? pending.current : { message_id: crypto.randomUUID(), text: text.trim() }
    pending.current = input
    void send(input).then((ok) => { if (ok) { pending.current = null; setText('') } })
  }}><label htmlFor="manager-reply">Ответ клиенту</label>
    <textarea id="manager-reply" rows={3} maxLength={4000} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} required />
    <button type="submit" className="accent-action" disabled={busy || !text.trim()}><Icon name="send" />Отправить ответ</button>
  </form>
}

export function ManagerConnected({ token, caseId, onLogout }: { token: string; caseId: string | null; onLogout: (message?: string) => void }) {
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [queue, setQueue] = useState<{ offset: number; items: QueueItem[]; error: string } | null>(null)
  const [detail, setDetail] = useState<{ id: string; data: AssignedHandoff | null; error: string; missing?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionIssue, setActionIssue] = useState<{ id: string; message: string } | null>(null)
  const operation = useRef<AbortController | null>(null)
  const logout = useRef(onLogout)
  useEffect(() => { logout.current = onLogout }, [onLogout])
  useEffect(() => () => operation.current?.abort(), [token, caseId])
  const unauthorized = (cause: unknown) => cause instanceof ApiError && cause.status === 401
  useEffect(() => {
    const request = new AbortController()
    let timer = 0
    async function poll() {
      try {
        if (document.visibilityState === 'hidden') return
        const items = await handoffApi.list(token, offset, request.signal)
        if (!request.signal.aborted) setQueue({ offset, items, error: '' })
      } catch (cause) {
        if (request.signal.aborted) return
        if (unauthorized(cause)) { logout.current('Токен не принят или истёк. Введите действующий токен.'); return }
        setQueue((previous) => ({ offset, items: previous?.offset === offset ? previous.items : [], error: cause instanceof Error ? cause.message : 'Не удалось загрузить очередь.' }))
      } finally { if (!request.signal.aborted) timer = window.setTimeout(() => void poll(), 5000) }
    }
    void poll()
    return () => { request.abort(); clearTimeout(timer) }
  }, [token, offset, revision])
  useEffect(() => {
    if (!caseId) return
    const request = new AbortController()
    let timer = 0
    async function poll() {
      try {
        if (document.visibilityState === 'hidden') { timer = window.setTimeout(() => void poll(), 5000); return }
        const data = await handoffApi.read(token, caseId!, request.signal)
        if (request.signal.aborted) return
        if (data.handoff.handoff_id !== caseId) throw new Error('Ответ относится к другому обращению.')
        setDetail({ id: caseId!, data, error: '' })
        if (data.handoff.status !== 'resolved') timer = window.setTimeout(() => void poll(), 5000)
      } catch (cause) {
        if (request.signal.aborted) return
        if (unauthorized(cause)) { logout.current('Доступ менеджера завершён. Введите токен повторно.'); return }
        const missing = cause instanceof ApiError && cause.status === 404
        setDetail((previous) => ({ id: caseId!, data: !missing && previous?.id === caseId ? previous.data : null,
          error: missing ? 'Контекст недоступен. Обращение может быть не назначено вам или больше недоступно.' : cause instanceof Error ? cause.message : 'Не удалось прочитать обращение.', missing }))
        if (!missing) timer = window.setTimeout(() => void poll(), 5000)
      }
    }
    void poll()
    return () => { request.abort(); clearTimeout(timer) }
  }, [token, caseId, revision])

  const items = queue?.offset === offset ? queue.items : []
  const selected = items.find((item) => item.handoff_id === caseId)
  const context = detail?.id === caseId ? detail : null
  async function act(kind: 'claim' | 'resolve' | 'reply', input?: ManagerReplyInput): Promise<boolean> {
    if (!caseId || operation.current) return false
    const request = new AbortController()
    operation.current = request
    setBusy(true); setActionIssue(null)
    try {
      if (kind === 'reply' && input) await handoffApi.reply(token, caseId, input, request.signal)
      else {
        const updated = await handoffApi[kind === 'claim' ? 'claim' : 'resolve'](token, caseId, request.signal)
        if (updated.handoff_id !== caseId) throw new Error('Ответ относится к другому обращению.')
        if (!request.signal.aborted) {
          setQueue((previous) => previous && ({ ...previous, items: previous.items.map((item) => item.handoff_id === updated.handoff_id ? updated : item) }))
          setDetail((previous) => previous?.id === caseId && previous.data ? { ...previous, data: { ...previous.data, handoff: updated } } : previous)
        }
      }
      if (request.signal.aborted) return false
      setRevision((value) => value + 1)
      return true
    } catch (cause) {
      if (!request.signal.aborted) {
        if (unauthorized(cause)) logout.current('Токен не принят. Войдите повторно.')
        else setActionIssue({ id: caseId, message: cause instanceof Error ? cause.message : 'Операция не подтверждена. Обновите состояние перед повтором.' })
      }
      return false
    } finally { if (operation.current === request) { operation.current = null; setBusy(false) } }
  }
  const error = queue?.offset === offset ? queue.error : ''
  return <ManagerWorkspace cases={items.map((item) => presentation(item))} caseId={caseId}
    controls={<button type="button" className="quiet-action" onClick={() => onLogout()}>Выйти</button>}
    pagination={<div className="queue-pagination">
      {(!queue || queue.offset !== offset) && <p role="status">Загружаем очередь…</p>}
      {error && <p role="alert">{error}</p>}
      <p>На странице: {items.length} · смещение: {offset}</p>
      <div><button type="button" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Назад</button>
        <button type="button" disabled={items.length < 50} onClick={() => setOffset((value) => value + 50)}>Далее</button></div>
      <button type="button" className="quiet-action" onClick={() => setRevision((value) => value + 1)}>Обновить</button>
    </div>}
    detail={caseId ? <>
      <div className="manager-case-actions"><a className="text-action" href="#/manager"><Icon name="back" />К очереди</a>
        {context?.data?.handoff.status === 'in_progress' && <button type="button" disabled={busy} onClick={() => void act('resolve')}>Завершить обращение</button>}
        {(context?.data?.handoff.status ?? selected?.status) === 'queued' && <button type="button" className="accent-action" disabled={busy} onClick={() => void act('claim')}>Взять в работу</button>}
      </div>
      {!context && <p className="manager-feedback" role="status">Загружаем контекст…</p>}
      {context?.error && <p className="manager-feedback" role="alert">{context.error}</p>}
      {actionIssue?.id === caseId && <p className="manager-feedback" role="alert">{actionIssue.message}</p>}
      {context?.data && <>
        <CaseDetail record={presentation(context.data.handoff, context.data.messages)} />
        {context.data.handoff.status === 'in_progress' && <ReplyForm key={caseId} busy={busy} send={(input) => act('reply', input)} />}
      </>}
    </> : undefined} />
}
