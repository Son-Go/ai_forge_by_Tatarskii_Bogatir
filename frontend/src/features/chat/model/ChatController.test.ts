import { describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/setup'
import { chatApi } from '../../../shared/api/chatApi'
import { browserStorage } from '../lib/sessionStorage'
import { ChatController } from './ChatController'

function controller() { return new ChatController(chatApi, browserStorage('test'), async () => { await new Promise((resolve) => setTimeout(resolve, 110)) }) }
describe('chat lifecycle through HTTP/SSE mocks', () => {
  it('creates one session across StrictMode restart', async () => {
    const create = vi.spyOn(chatApi, 'createSession')
    const chat = controller()
    const first = chat.start(); chat.stop(); await chat.start(); await first
    expect(create).toHaveBeenCalledTimes(1)
    expect(chat.getSnapshot().phase).toBe('ready')
  })
  it('streams, prevents double send, selects a card and restores after reload', async () => {
    const chat = controller(); await chat.start()
    const sending = chat.send('Подобрать решение на 50 пользователей')
    await chat.send('Этот вопрос не должен отправиться')
    await sending
    expect(chat.getSnapshot().session?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const offer = chat.getSnapshot().session!.messages[1]!.cards[0]!
    await chat.select(offer)
    expect(chat.getSnapshot().session?.selected_offer?.offer_id).toBe(offer.offer_id)
    const restored = controller(); await restored.start()
    expect(restored.getSnapshot().session).toEqual(chat.getSnapshot().session)
  })
  it('retries a failed turn with one user message and a new request ID', async () => {
    const chat = controller(); await chat.start(); await chat.send('Ошибка модели')
    expect(chat.getSnapshot().issue?.action).toBe('retry')
    await chat.repeat()
    expect(chat.getSnapshot().phase).toBe('ready')
    expect(chat.getSnapshot().issue).toBeNull()
    expect(chat.getSnapshot().session?.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(chat.getSnapshot().session?.last_turn?.status).toBe('complete')
  })
  it('recovers from a stream ending before done', async () => {
    const chat = controller(); await chat.start(); await chat.send('Обрыв ответа')
    expect(chat.getSnapshot().phase).toBe('ready')
    expect(chat.getSnapshot().session?.last_turn?.status).toBe('complete')
    expect(chat.getSnapshot().session?.messages.at(-1)?.status).toBe('complete')
    expect(chat.getSnapshot().streamText).toBe('')
  })
  it('offers retry when a disconnected stream resolves to a saved timeout', async () => {
    const chat = controller(); await chat.start()
    const session = chat.getSnapshot().session!
    const turnId = crypto.randomUUID()
    vi.spyOn(chatApi, 'getSession').mockResolvedValueOnce({
      ...session, last_turn: { turn_id: turnId, status: 'failed', error_code: 'TURN_TIMEOUT' },
    })
    vi.spyOn(chatApi, 'sendMessage').mockImplementationOnce(async (_id, input, onEvent) => {
      onEvent({ type: 'accepted', data: {
        turn_id: turnId, client_message_id: input.client_message_id,
        user_message_id: crypto.randomUUID(), request_id: crypto.randomUUID(),
      } })
      throw new Error('stream interrupted')
    })
    await chat.send('Синтетическая проверка')
    expect(chat.getSnapshot().issue?.action).toBe('retry')
    expect(chat.getSnapshot().issue?.message).toContain('Истекло время ожидания модели')
  })
  it('preserves a partial answer when retrying after a saved error', async () => {
    const chat = controller(); await chat.start(); await chat.send('Ошибка после блока')
    expect(chat.getSnapshot().session?.messages.at(-1)?.status).toBe('partial')
    await chat.repeat()
    const messages = chat.getSnapshot().session!.messages
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(messages.filter((m) => m.role === 'assistant').map((m) => m.status)).toEqual(['partial', 'complete'])
  })
  it('keeps historical prices when reconfirming a changed offer', async () => {
    const chat = controller(); await chat.start(); await chat.send('Подбор: изменение предложения')
    const old = chat.getSnapshot().session!.messages.at(-1)!.cards[0]!
    await chat.select(old)
    const updated = chat.getSnapshot().updatedOffer!
    expect(updated.price?.amount).toBe('12500.00')
    expect(old.price?.amount).toBe('12000.00')
    await chat.select(updated)
    expect(chat.getSnapshot().session?.selected_offer?.catalog_version).toBe(updated.catalog_version)
  })
  it('handles rate limits without storing a duplicate optimistic message', async () => {
    const chat = controller(); await chat.start(); await chat.send('Лимит')
    expect(chat.getSnapshot().phase).toBe('ready')
    expect(chat.getSnapshot().optimistic).toBeNull()
    expect(chat.getSnapshot().session?.messages).toHaveLength(0)
    expect(chat.getSnapshot().issue?.message).toContain('Слишком много')
    expect(chat.getSnapshot().rejectedText).toBe('Лимит')
  })
  it('reuses the request ID when retrying an unconfirmed delivery', async () => {
    server.use(http.post('/api/v1/sessions/:id/messages', () => HttpResponse.error(), { once: true }))
    const send = vi.spyOn(chatApi, 'sendMessage')
    const chat = controller(); await chat.start(); await chat.send('Подобрать решение')
    expect(chat.getSnapshot().issue?.action).toBe('resend')
    await chat.repeat()
    expect(send.mock.calls[0]![1].client_message_id).toBe(send.mock.calls[1]![1].client_message_id)
    expect(chat.getSnapshot().session?.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })
  it('reconciles an offer-level 404 without discarding the session', async () => {
    const chat = controller(); await chat.start(); await chat.send('Подобрать решение')
    const id = chat.getSnapshot().session!.session_id
    server.use(http.post('/api/v1/sessions/:id/selection', () => HttpResponse.json({ code: 'OFFER_NOT_FOUND', message: 'Предложение не найдено.', request_id: 'mock-selection' }, { status: 404 }), { once: true }))
    await chat.select(chat.getSnapshot().session!.messages.at(-1)!.cards[0]!)
    expect(chat.getSnapshot().phase).toBe('ready')
    expect(chat.getSnapshot().session?.session_id).toBe(id)
    expect(chat.getSnapshot().issue?.message).toBe('Предложение не найдено.')
  })
  it('returns to the welcome screen if the saved session is unavailable', async () => {
    const storage = browserStorage('test'); storage.setSession(crypto.randomUUID())
    const chat = new ChatController(chatApi, storage)
    await chat.start()
    expect(chat.getSnapshot().phase).toBe('ready')
    expect(chat.getSnapshot().issue).toBeNull()
    expect(storage.getSession()).toBeNull()
    await chat.send('Подобрать решение')
    expect(chat.getSnapshot().session?.messages[0]?.text).toBe('Подобрать решение')
  })
})
