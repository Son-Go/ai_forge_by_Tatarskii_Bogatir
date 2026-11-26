import { delay, http, HttpResponse } from 'msw'
import { demoQuotePdf } from './quoteDraftPdf'
import clarifyExample from '../../../contracts/examples/public-clarify.sse?raw'
import recommendExample from '../../../contracts/examples/public-recommend.sse?raw'
import failedExample from '../../../contracts/examples/public-failed.sse?raw'
import { isMessage } from '../shared/api/guards'
import type { ChatEvent, Message, MessageInput, Session } from '../shared/api/types'

interface TurnRecord { input: MessageInput; userId: string; events: ChatEvent[] }
interface MockRecord { session: Session; turns: Record<string, TurnRecord>; resumeAt?: number; finalMessage?: Message; changed?: boolean }
const db = new Map<string, MockRecord>()
const storeKey = 'softline:mock:server'
const uuid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const encode = (event: ChatEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
const encoder = new TextEncoder()

function exampleMessage(raw: string): Message {
  const line = raw.split('\n').find((x) => x.startsWith('data: ') && x.includes('"outcome"'))
  if (!line) throw new Error('Missing contract fixture')
  const data: unknown = JSON.parse(line.slice(6))
  if (typeof data !== 'object' || data === null || !('message' in data) || !isMessage(data.message)) throw new Error('Invalid contract fixture')
  return structuredClone(data.message)
}
const clarification = exampleMessage(clarifyExample)
const recommendation = exampleMessage(recommendExample)
const failureLine = failedExample.split('\n').find((x) => x.startsWith('data: ') && x.includes('"retryable"'))
const failure = JSON.parse(failureLine!.slice(6)) as { code: string; message: string; retryable: boolean }

function save() { try { localStorage.setItem(storeKey, JSON.stringify([...db])) } catch { /* In-memory mock is still usable. */ } }
function load() {
  if (db.size) return
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(storeKey) || '[]')
    if (Array.isArray(entries)) for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]?.session) {
        const record = entry[1] as MockRecord
        // A reload stops the in-page mock producer. Preserve its partial reply,
        // rather than pretending a model is still running in another process.
        if (record.session.last_turn?.status === 'running' && !record.resumeAt) {
          record.session.last_turn.status = 'failed'
          record.session.last_turn.error_code = 'MOCK_INTERRUPTED'
          for (const message of record.session.messages) if (message.status === 'streaming') message.status = 'partial'
        }
        db.set(entry[0], record)
      }
    }
  } catch { /* Corrupt mock storage starts empty. */ }
}
export function resetMockDb() { db.clear(); try { localStorage.removeItem(storeKey) } catch { /* Node tests. */ } }
function error(code: string, message: string, status: number, extra = {}) {
  return HttpResponse.json({ code, message, request_id: `mock-${uuid()}`, ...extra }, { status })
}
function find(id: string | readonly string[] | undefined) { load(); return typeof id === 'string' ? db.get(id) : undefined }

export const handlers = [
  http.get('/api/v1/sessions/:id/handoff', () => HttpResponse.json({ handoff: null })),
  http.post('/api/v1/sessions/:id/quote-drafts', async ({ params, request }) => {
    const record = find(params.id)
    if (!record) return error('SESSION_NOT_FOUND', 'Диалог не найден.', 404)
    if (!record.session.quotes_enabled) return error('QUOTES_DISABLED', 'Черновики КП отключены.', 403)
    if (record.session.last_turn?.status === 'running') return error('TURN_IN_PROGRESS', 'Дождитесь завершения ответа.', 409)
    const selected = record.session.selected_offer
    if (!selected) return error('NO_SELECTION', 'Сначала выберите предложение.', 400)
    const input: unknown = await request.json().catch(() => null)
    if (!input || typeof input !== 'object' || !('customer_name' in input) || typeof input.customer_name !== 'string' || !input.customer_name.trim() || input.customer_name.length > 160
      || !('quantity' in input) || typeof input.quantity !== 'number' || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 99999) {
      return new HttpResponse('Некорректные параметры демонстрационного КП.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    if (!selected.price || /^0+(\.0+)?$/.test(selected.price.amount)) return error('PRICE_UNCONFIRMED', 'Цену необходимо подтвердить у менеджера.', 409)
    return new HttpResponse(demoQuotePdf(), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="DEMO-softline-quote-draft.pdf"' } })
  }),
  http.post('/api/v1/sessions', () => {
    load()
    const session_id = uuid()
    db.set(session_id, { session: { session_id, messages: [], selected_offer: null, last_turn: null, quotes_enabled: true }, turns: {} })
    save()
    return HttpResponse.json({ session_id }, { status: 201 })
  }),
  http.get('/api/v1/sessions/:id', ({ params }) => {
    const record = find(params.id)
    if (!record) return error('SESSION_NOT_FOUND', 'Диалог не найден.', 404)
    if (record.resumeAt && Date.now() >= record.resumeAt && record.finalMessage && record.session.last_turn) {
      const saved = record.session.messages.find((m) => m.id === record.finalMessage?.id)
      if (saved) Object.assign(saved, record.finalMessage, { status: 'complete' })
      record.session.last_turn.status = 'complete'
      record.session.last_turn.outcome = 'recommend'
      delete record.resumeAt
      save()
    }
    return HttpResponse.json(record.session)
  }),
  http.post('/api/v1/sessions/:id/messages', async ({ params, request }) => {
    const record = find(params.id)
    if (!record) return error('SESSION_NOT_FOUND', 'Диалог не найден.', 404)
    const input = await request.json() as MessageInput
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || typeof input.client_message_id !== 'string') return error('INVALID_INPUT', 'Введите сообщение.', 400)
    if (/лимит/i.test(input.text)) return error('RATE_LIMITED', 'Слишком много запросов. Попробуйте немного позже.', 429)
    const previous = record.turns[input.client_message_id]
    if (previous && JSON.stringify(previous.input) !== JSON.stringify(input)) return error('IDEMPOTENCY_CONFLICT', 'Идентификатор уже связан с другим запросом.', 409)
    if (record.session.last_turn?.status === 'running') return error('TURN_IN_PROGRESS', 'Ответ ещё обрабатывается.', 409, { turn_id: record.session.last_turn.turn_id })
    if (previous) return new HttpResponse(previous.events.map(encode).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    let userId: string = uuid()
    if (input.retry_of_turn_id) {
      const old = Object.values(record.turns).find((t) => t.events.some((e) => e.type === 'accepted' && e.data.turn_id === input.retry_of_turn_id))
      if (!old || old.input.text !== input.text || !old.events.some((e) => e.type === 'failed' && e.data.retryable)) return error('INVALID_RETRY', 'Этот ход нельзя повторить.', 400)
      userId = old.userId
    } else record.session.messages.push({ id: userId, role: 'user', text: input.text, cards: [], sources: [], status: 'complete', created_at: now() })
    const turnId = uuid()
    record.session.last_turn = { turn_id: turnId, status: 'running' }
    const events: ChatEvent[] = []
    const savedTurn: TurnRecord = { input, userId, events }
    record.turns[input.client_message_id] = savedTurn
    record.changed = /изменение/i.test(input.text)
    save()
    const stepByStep = import.meta.env.MODE === 'mock' && document.documentElement.dataset.mockSseStepped === 'true'
    const nextBlock = 'softline:mock-next-delta'
    let releaseStep: (() => void) | undefined
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: ChatEvent) => {
          events.push(event)
          if (!cancelled) controller.enqueue(encoder.encode(encode(event)))
        }
        emit({ type: 'accepted', data: { turn_id: turnId, client_message_id: input.client_message_id, user_message_id: userId, request_id: `mock-${uuid()}` } })
        emit({ type: 'status', data: { stage: 'interpreting' } })
        if (!cancelled) controller.enqueue(encoder.encode(': heartbeat\n\n'))
        await delay(import.meta.env.MODE === 'test' ? 1 : 250)
        const fail = /ошибка/i.test(input.text) && !input.retry_of_turn_id
        if (fail) {
          if (/после/i.test(input.text)) {
            const text = 'Начали проверять данные каталога.'
            record.session.messages.push({ id: uuid(), role: 'assistant', text, cards: [], sources: [], status: 'partial', created_at: now() })
            emit({ type: 'delta', data: { seq: 1, text } })
          }
          record.session.last_turn = { turn_id: turnId, status: 'failed', error_code: failure.code }
          emit({ type: 'failed', data: { turn_id: turnId, code: failure.code, message: failure.message, retryable: failure.retryable } })
        } else {
          emit({ type: 'status', data: { stage: 'searching' } })
          const complex = /проверьте.*справк|переда.*менеджер|вне каталога|заказать.*партн[её]р/i.test(input.text)
          const question = /документ|оплат|вопрос/i.test(input.text)
          const recommend = !question && (record.session.messages.filter((m) => m.role === 'user').length > 1 || /50|подоб|без цены|обрыв|изменение|решение/i.test(input.text))
          const message = structuredClone(question ? { ...clarification,
            text: 'Это демонстрационный ответ по базе знаний. В рабочем режиме здесь будут проверенные сведения и источники от Backend.',
            sources: [{ id: 'demo-knowledge', title: 'Демонстрационный источник', url: 'https://example.com/knowledge', kind: 'knowledge' as const, checked_at: now() }],
          } : recommend ? recommendation : clarification)
          if (complex) { message.text = 'В этом демонстрационном случае требуется специалист. Ниже можно зарегистрировать локальное демообращение с историей и причиной. Реальному менеджеру оно не отправляется.'; message.cards = []; message.sources = [] }
          message.id = uuid(); message.created_at = now(); message.status = 'complete'
          if (/без цены/i.test(input.text) && message.cards[0]) message.cards[0].price = null
          emit({ type: 'status', data: { stage: 'generating' } })
          if (/обрыв/i.test(input.text)) {
            const partial = { ...message, text: message.text.slice(0, 12), cards: [], sources: [], status: 'streaming' as const }
            record.session.messages.push(partial)
            record.finalMessage = message; record.resumeAt = Date.now() + 100
            emit({ type: 'delta', data: { seq: 1, text: partial.text } })
            save()
            if (!cancelled) controller.close()
            return
          }
          let seq = 0
          let text = ''
          const partial = { ...message, text: '', cards: [], sources: [], status: 'streaming' as const }
          record.session.messages.push(partial)
          for (const part of message.text.match(/.{1,18}/gu) || []) {
            text += part; partial.text = text
            save()
            const pause = stepByStep && seq < 2 ? new Promise<void>((resolve) => {
              const resume = () => {
                window.removeEventListener(nextBlock, resume)
                releaseStep = undefined
                resolve()
              }
              releaseStep = resume
              window.addEventListener(nextBlock, resume, { once: true })
            }) : delay(import.meta.env.MODE === 'test' ? 1 : 45)
            emit({ type: 'delta', data: { seq: ++seq, text: part } })
            await pause
            if (stepByStep && cancelled) return
          }
          Object.assign(partial, message)
          record.session.last_turn = { turn_id: turnId, status: 'complete', outcome: complex ? 'insufficient_data' : question ? 'answer' : recommend ? 'recommend' : 'clarify' }
          save()
          emit({ type: 'done', data: { turn_id: turnId, outcome: record.session.last_turn.outcome!, message } })
        }
        save()
        if (!cancelled) controller.close()
      },
      cancel() { cancelled = true; releaseStep?.() },
    })
    return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
  }),
  http.post('/api/v1/sessions/:id/selection', async ({ params, request }) => {
    const record = find(params.id)
    if (!record) return error('SESSION_NOT_FOUND', 'Диалог не найден.', 404)
    if (record.session.last_turn?.status === 'running') return error('TURN_IN_PROGRESS', 'Дождитесь завершения ответа.', 409)
    const input = await request.json() as { offer_id: string; catalog_version: string }
    const cards = record.session.messages.flatMap((m) => m.cards)
    const offer = cards.find((c) => c.offer_id === input.offer_id && c.catalog_version === input.catalog_version)
    if (!offer) return error('OFFER_NOT_FOUND', 'Предложение не найдено.', 404)
    if (record.changed) {
      record.changed = false
      const updated = { ...offer, catalog_version: uuid(), price: { amount: '12500.00', currency: 'RUB' } }
      record.session.messages.push({ id: uuid(), role: 'assistant', text: 'Актуальные данные демонстрационного предложения.',
        cards: [updated], sources: recommendation.sources, status: 'complete', created_at: now() })
      save()
      return error('OFFER_CHANGED', 'Предложение изменилось.', 409, { updated_offer: updated })
    }
    record.session.selected_offer = offer
    save()
    return HttpResponse.json(offer)
  }),
]
