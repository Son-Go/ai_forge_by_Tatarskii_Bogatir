import type { ChatApi } from '../../../shared/api/chatApi'
import { ApiError } from '../../../shared/api/client'
import type { ChatEvent, MessageInput, Offer, Session } from '../../../shared/api/types'
import { recentSessionLimit, type ChatStorage, type PendingMessage, type RecentSession } from '../lib/sessionStorage'
import { chatReducer, initialState, type Action, type Issue } from './chatReducer'

export class ChatController {
  private state = initialState
  private listeners = new Set<() => void>()
  private operation = new AbortController()
  private recentLoad = new AbortController()
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
  stop = () => { this.operation.abort(); this.recentLoad.abort(); ++this.epoch }
  private current(epoch: number) { return epoch === this.epoch }

  showUpdatedOffer = (offer?: Offer) => {
    if (this.state.phase === 'ready') this.patch({ type: 'patch', value: { updatedOffer: offer ?? null } })
  }

  private remember(session: Session) {
    const title = session.messages.find((message) => message.role === 'user')?.text.trim()
    const updatedAt = session.messages.at(-1)?.created_at
    if (!title || !updatedAt) return
    const id = session.session_id
    const existing = this.state.recentDialogs.find((dialog) => dialog.id === id)
    if (existing && Date.parse(existing.updatedAt) >= Date.parse(updatedAt)) return
    const byActivity = (a: RecentSession, b: RecentSession) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    const refs = this.storage.getRecent().filter((dialog) => dialog.id !== id)
    this.storage.setRecent([...refs, { id, updatedAt }].sort(byActivity).slice(0, recentSessionLimit))
    const dialogs = this.state.recentDialogs.filter((dialog) => dialog.id !== id)
    const preview = title.replace(/\s+/g, ' ')
    this.patch({ type: 'patch', value: { recentDialogs: [...dialogs, { id, updatedAt,
      title: preview.length > 100 ? `${preview.slice(0, 99)}…` : preview }].sort(byActivity).slice(0, recentSessionLimit) } })
  }

  private forgetRecent(id: string) {
    this.storage.setRecent(this.storage.getRecent().filter((entry) => entry.id !== id))
    this.storage.setPending(id, null)
    this.patch({ type: 'patch', value: { recentDialogs: this.state.recentDialogs.filter((dialog) => dialog.id !== id) } })
  }

  private async loadRecent(activeId: string, signal: AbortSignal) {
    await Promise.all(this.storage.getRecent().filter(({ id }) => id !== activeId).map(async ({ id }) => {
      try {
        const session = await this.api.getSession(id, signal)
        if (!signal.aborted && session.session_id === id) this.remember(session)
      } catch (error) {
        if (!signal.aborted && error instanceof ApiError && error.status === 404) this.forgetRecent(id)
      }
    }))
  }

  start = async (fresh = false) => {
    const epoch = this.begin()
    this.recentLoad.abort()
    this.recentLoad = new AbortController()
    this.patch({ type: 'patch', value: { phase: 'booting', issue: null } })
    const savedId = fresh ? null : this.storage.getSession()
    try {
      let id = savedId
      if (!id) {
        // Share the POST across React StrictMode's setup/cleanup/setup cycle.
        this.creation ??= this.api.createSession().then((sessionId) => {
          this.storage.setSession(sessionId); return sessionId
        }).finally(() => { this.creation = null })
        id = await this.creation
      }
      if (this.current(epoch)) {
        void this.loadRecent(id, this.recentLoad.signal)
        await this.restore(epoch, id)
      }
    } catch (error) {
      if (!this.current(epoch)) return
      if (savedId && error instanceof ApiError && error.status === 404 && error.body.code === 'SESSION_NOT_FOUND') {
        if (this.storage.getSession() === savedId) this.storage.setSession(null)
        this.dispatch({ type: 'reset', phase: 'ready' })
      } else this.loadError(error)
    }
  }

  newSession = async () => {
    if (!['ready', 'unavailable'].includes(this.state.phase)) return
    const epoch = this.begin()
    this.dispatch({ type: 'reset' })
    try {
      const id = await this.api.createSession()
      if (this.current(epoch)) {
        this.storage.setSession(id)
        await this.restore(epoch, id)
      }
    } catch (error) { if (this.current(epoch)) this.loadError(error) }
  }

  goHome = () => {
    if (!['ready', 'unavailable'].includes(this.state.phase)) return
    this.begin()
    this.storage.setSession(null)
    this.dispatch({ type: 'reset', phase: 'ready' })
  }

  openSession = async (id: string) => {
    const phase = this.state.phase
    if ((phase !== 'ready' && phase !== 'unavailable') || this.state.session?.session_id === id) return
    const epoch = this.begin()
    this.patch({ type: 'patch', value: { phase: 'booting', recentIssue: null } })
    try { await this.restore(epoch, id, undefined, true) }
    catch (error) {
      if (!this.current(epoch)) return
      if (this.state.session?.session_id === id) this.loadError(error)
      else this.patch({ type: 'patch', value: { phase, recentIssue: error instanceof ApiError && error.status === 404
        ? 'Этот диалог больше недоступен.' : 'Не удалось открыть диалог. Попробуйте ещё раз.' } })
    }
  }

  recover = async () => {
    if (['sending', 'streaming', 'selecting', 'booting'].includes(this.state.phase)) return
    const id = this.state.session?.session_id || this.storage.getSession()
    if (!id) return this.start()
    const epoch = this.begin()
    this.patch({ type: 'patch', value: { phase: 'recovering', issue: null } })
    try { await this.restore(epoch, id) } catch (error) { if (this.current(epoch)) this.loadError(error) }
  }

  private async restore(epoch: number, id: string, knownIssue?: Issue, activate = false) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const session = await this.api.getSession(id, this.operation.signal).catch((error: unknown) => {
        if (this.current(epoch) && error instanceof ApiError && error.status === 404) this.forgetRecent(id)
        throw error
      })
      if (!this.current(epoch)) return
      if (session.session_id !== id) throw new Error('Ответ относится к другому диалогу.')
      if (activate && attempt === 0) {
        this.storage.setSession(id)
        this.dispatch({ type: 'reset' })
      }
      this.remember(session)
      this.dispatch({ type: 'session', session })
      if (session.last_turn?.status !== 'running') {
        const pending = this.storage.getPending(id)
        let issue = knownIssue || null
        if (pending?.sessionId === id) {
          if (pending.turnId && session.last_turn?.turn_id === pending.turnId && session.last_turn.status === 'complete') this.storage.setPending(id, null)
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
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > 4000 || this.state.phase !== 'ready') return
    // An unresolved delivery must be reconciled, not replaced by a new ID.
    if (this.state.issue?.action === 'resend') return
    if (!this.state.session) {
      await this.start(true)
      if (!this.state.session || this.state.phase !== 'ready') {
        this.patch({ type: 'patch', value: { rejectedText: text } })
        return
      }
    }
    await this.submit({ client_message_id: crypto.randomUUID(), text: trimmed })
  }

  repeat = async () => {
    const id = this.state.session?.session_id
    if (!id || this.state.phase !== 'ready') return
    const pending = this.storage.getPending(id)
    if (!pending) return
    if (this.state.issue?.action === 'retry' && pending.retryable && pending.turnId) {
      await this.submit({ client_message_id: crypto.randomUUID(), text: pending.input.text, retry_of_turn_id: pending.turnId })
    } else if (this.state.issue?.action === 'resend') await this.submit(pending.input)
  }

  private async submit(input: MessageInput) {
    const session = this.state.session
    if (!session) return
    const id = session.session_id
    const epoch = this.begin()
    const pending: PendingMessage = { sessionId: session.session_id, input }
    this.storage.setPending(id, pending)
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
          this.storage.setPending(id, pending)
        }
        if (event.type === 'failed') {
          pending.retryable = event.data.retryable
          this.storage.setPending(id, pending)
          failure = { message: event.data.message, action: event.data.retryable ? 'retry' : undefined }
        }
        if (event.type === 'done') { completed = true; this.storage.setPending(id, null) }
        this.dispatch({ type: 'event', event })
      }, this.operation.signal)
      if (!this.current(epoch)) return
      this.patch({ type: 'patch', value: { phase: 'recovering' } })
      await this.restore(epoch, session.session_id, failure)
    } catch (error) {
      if (!this.current(epoch)) return
      if (error instanceof ApiError && error.status === 404) { this.forgetRecent(id); this.loadError(error); return }
      if (error instanceof ApiError && error.body.code === 'IDEMPOTENCY_CONFLICT') {
        this.storage.setPending(id, null)
        try { await this.restore(epoch, session.session_id, { message: 'Конфликт идентификатора сообщения. История обновлена; проверьте её перед продолжением.', requestId: error.body.request_id }) }
        catch (restoreError) { if (this.current(epoch)) this.loadError(restoreError) }
        return
      }
      if (error instanceof ApiError && [400, 403, 429].includes(error.status)) {
        this.storage.setPending(id, null)
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
    if (session.session_id !== id) throw new Error('Ответ относится к другому диалогу.')
    if (session.last_turn?.status === 'running') { await this.recover(); return }
    this.remember(session)
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
