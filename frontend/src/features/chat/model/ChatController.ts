import type { ChatApi } from '../../../shared/api/chatApi'
import { ApiError } from '../../../shared/api/client'
import type { ChatEvent, MessageInput, Offer } from '../../../shared/api/types'
import type { ChatStorage, PendingMessage } from '../lib/sessionStorage'
import { chatReducer, initialState, type Action, type Issue } from './chatReducer'

export class ChatController {
  private state = initialState
  private listeners = new Set<() => void>()
  private operation = new AbortController()
  private epoch = 0
  private creation: Promise<string> | null = null
  constructor(private api: ChatApi, private storage: ChatStorage,
    private wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })) {}

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private dispatch(action: Action) { this.state = chatReducer(this.state, action); this.listeners.forEach((fn) => fn()) }
  private patch(value: Parameters<typeof chatReducer>[1] & { type: 'patch' }) { this.dispatch(value) }
  private begin() { this.operation.abort(); this.operation = new AbortController(); return ++this.epoch }
  stop = () => { this.operation.abort(); ++this.epoch }
  private current(epoch: number) { return epoch === this.epoch }

  start = async () => {
    const epoch = this.begin()
    this.patch({ type: 'patch', value: { phase: 'booting', issue: null } })
    try {
      let id = this.storage.getSession()
      if (!id) {
        // Share the POST across React StrictMode's setup/cleanup/setup cycle.
        this.creation ??= this.api.createSession().then((sessionId) => {
          this.storage.setSession(sessionId); return sessionId
        }).finally(() => { this.creation = null })
        id = await this.creation
      }
      if (this.current(epoch)) await this.restore(epoch, id)
    } catch (error) { if (this.current(epoch)) this.loadError(error) }
  }

  newSession = async () => {
    if (!['ready', 'unavailable'].includes(this.state.phase)) return
    const epoch = this.begin()
    this.dispatch({ type: 'reset' })
    try {
      const id = await this.api.createSession()
      this.storage.setSession(id)
      this.storage.setPending(null)
      if (this.current(epoch)) await this.restore(epoch, id)
    } catch (error) { if (this.current(epoch)) this.loadError(error) }
  }

  recover = async () => {
    if (['sending', 'streaming', 'selecting', 'booting'].includes(this.state.phase)) return
    const id = this.state.session?.session_id || this.storage.getSession()
    if (!id) return this.start()
    const epoch = this.begin()
    this.patch({ type: 'patch', value: { phase: 'recovering', issue: null } })
    try { await this.restore(epoch, id) } catch (error) { if (this.current(epoch)) this.loadError(error) }
  }

  private async restore(epoch: number, id: string, knownIssue?: Issue) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const session = await this.api.getSession(id, this.operation.signal)
      if (!this.current(epoch)) return
      this.dispatch({ type: 'session', session })
      if (session.last_turn?.status !== 'running') {
        const pending = this.storage.getPending()
        let issue = knownIssue || null
        if (pending?.sessionId === id) {
          if (pending.turnId && session.last_turn?.turn_id === pending.turnId && session.last_turn.status === 'complete') this.storage.setPending(null)
          else if (pending.turnId && session.last_turn?.turn_id === pending.turnId && session.last_turn.status === 'failed') {
            issue ??= { message: 'Ответ был прерван. Сохранённая история восстановлена.', action: pending.retryable ? 'retry' : undefined }
          } else issue ??= { message: 'Доставка последнего сообщения не подтверждена. Можно безопасно повторить отправку с прежним идентификатором.', action: 'resend' }
        } else if (session.last_turn?.status === 'failed') issue ??= { message: 'Предыдущий ответ был прерван. История восстановлена; можно продолжить диалог.' }
        this.patch({ type: 'patch', value: { issue } })
        return
      }
      await this.wait(Math.min(1000 * (attempt + 1), 5000), this.operation.signal)
    }
    if (this.current(epoch)) this.patch({ type: 'patch', value: {
      phase: 'recovering', issue: { message: 'Ответ ещё обрабатывается. Проверьте состояние через некоторое время.', action: 'restore' },
    } })
  }

  send = async (text: string) => {
    if (!text.trim() || text.trim().length > 4000 || this.state.phase !== 'ready' || !this.state.session) return
    // An unresolved delivery must be reconciled, not replaced by a new ID.
    if (this.state.issue?.action === 'resend') return
    const input = { client_message_id: crypto.randomUUID(), text: text.trim() }
    await this.submit(input)
  }

  repeat = async () => {
    const pending = this.storage.getPending()
    if (!pending || pending.sessionId !== this.state.session?.session_id || this.state.phase !== 'ready') return
    if (this.state.issue?.action === 'retry' && pending.retryable && pending.turnId) {
      await this.submit({ client_message_id: crypto.randomUUID(), text: pending.input.text, retry_of_turn_id: pending.turnId })
    } else if (this.state.issue?.action === 'resend') await this.submit(pending.input)
  }

  private async submit(input: MessageInput) {
    const session = this.state.session
    if (!session) return
    const epoch = this.begin()
    const pending: PendingMessage = { sessionId: session.session_id, input }
    this.storage.setPending(pending)
    this.patch({ type: 'patch', value: { phase: 'sending', issue: null, updatedOffer: null, rejectedText: null, streamText: '', stage: null,
      optimistic: input.retry_of_turn_id ? null : { id: input.client_message_id, role: 'user', text: input.text,
        cards: [], sources: [], created_at: new Date().toISOString(), status: 'complete' } } })
    let failure: Issue | undefined
    let completed = false
    try {
      await this.api.sendMessage(session.session_id, input, (event: ChatEvent) => {
        if (!this.current(epoch)) return
        if (event.type === 'accepted') {
          if (event.data.client_message_id !== input.client_message_id) throw new Error('Ответ относится к другому сообщению')
          pending.turnId = event.data.turn_id
          this.storage.setPending(pending)
        }
        if (event.type === 'failed') {
          pending.retryable = event.data.retryable
          this.storage.setPending(pending)
          failure = { message: event.data.message, action: event.data.retryable ? 'retry' : undefined }
        }
        if (event.type === 'done') { completed = true; this.storage.setPending(null) }
        this.dispatch({ type: 'event', event })
      }, this.operation.signal)
      if (!this.current(epoch)) return
      this.patch({ type: 'patch', value: { phase: 'recovering' } })
      await this.restore(epoch, session.session_id, failure)
    } catch (error) {
      if (!this.current(epoch)) return
      if (error instanceof ApiError && error.status === 404) { this.loadError(error); return }
      if (error instanceof ApiError && error.body.code === 'IDEMPOTENCY_CONFLICT') {
        this.storage.setPending(null)
        try { await this.restore(epoch, session.session_id, { message: 'Конфликт идентификатора сообщения. История обновлена; проверьте её перед продолжением.', requestId: error.body.request_id }) }
        catch (restoreError) { if (this.current(epoch)) this.loadError(restoreError) }
        return
      }
      if (error instanceof ApiError && [400, 403, 429].includes(error.status)) {
        this.storage.setPending(null)
        this.patch({ type: 'patch', value: { phase: 'ready', optimistic: null, streamText: '', stage: null, rejectedText: input.text,
          issue: { message: error.message, requestId: error.body.request_id } } })
        return
      }
      this.patch({ type: 'patch', value: { phase: 'recovering', stage: null,
        issue: { message: completed ? 'Ответ сохранён. Проверяем состояние диалога.' : 'Соединение прервано. Восстанавливаем диалог.' } } })
      try { await this.restore(epoch, session.session_id, failure) }
      catch (restoreError) { if (this.current(epoch)) this.loadError(restoreError) }
    }
  }

  // Background handoff updates never replace an active send/selection or its draft.
  refreshHistory = async (signal: AbortSignal) => {
    const id = this.state.session?.session_id
    if (!id || this.state.phase !== 'ready' || this.state.issue?.action === 'resend') return
    const epoch = this.epoch
    const session = await this.api.getSession(id, signal)
    if (!this.current(epoch) || this.state.phase !== 'ready' || signal.aborted) return
    if (session.last_turn?.status === 'running') { await this.recover(); return }
    this.dispatch({ type: 'session', session })
  }

  select = async (offer: Offer) => {
    if (this.state.phase !== 'ready' || !this.state.session || this.state.issue?.action === 'resend') return
    const epoch = this.begin()
    this.patch({ type: 'patch', value: { phase: 'selecting', issue: null, updatedOffer: null } })
    try {
      await this.api.selectOffer(this.state.session.session_id, offer, this.operation.signal)
      if (this.current(epoch)) await this.restore(epoch, this.state.session.session_id)
    } catch (error) {
      if (!this.current(epoch)) return
      if (error instanceof ApiError && error.body.code === 'OFFER_CHANGED') {
        this.patch({ type: 'patch', value: { phase: 'ready', updatedOffer: error.body.updated_offer || null,
          issue: { message: error.body.updated_offer ? 'Предложение изменилось. Проверьте новые данные и подтвердите выбор.' : 'Предложение больше недоступно. Попросите консультанта подобрать другое.' } } })
      } else {
        this.patch({ type: 'patch', value: { phase: 'recovering', issue: null } })
        try {
          await this.restore(epoch, this.state.session!.session_id, {
            message: error instanceof ApiError ? error.message : 'Не удалось подтвердить выбор. Состояние диалога обновлено; проверьте выбранное предложение.',
          })
        } catch (restoreError) { if (this.current(epoch)) this.loadError(restoreError) }
      }
    }
  }

  private loadError(error: unknown) {
    const unavailable = error instanceof ApiError && error.status === 404
    this.patch({ type: 'patch', value: {
      phase: unavailable || !this.state.session ? 'unavailable' : 'recovering', stage: null,
      issue: { message: unavailable ? 'Этот диалог недоступен. Начните новый диалог.'
        : error instanceof Error ? error.message : 'Не удалось связаться с сервисом.',
      action: unavailable ? 'new-session' : 'restore', requestId: error instanceof ApiError ? error.body.request_id : undefined },
    } })
  }
}
