import { jsonRequest, requireOk } from './client'
import { isOffer, isSession } from './guards'
import { readChatStream } from './sse'
import type { ChatEvent, MessageInput, Offer, Session } from './types'

export interface ChatApi {
  createSession(): Promise<string>
  getSession(id: string, signal?: AbortSignal): Promise<Session>
  sendMessage(id: string, input: MessageInput, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void>
  selectOffer(id: string, offer: Offer, signal: AbortSignal): Promise<Offer>
}

export const chatApi: ChatApi = {
  async createSession() {
    const result = await jsonRequest('/api/v1/sessions', (v): v is { session_id: string } =>
      typeof v === 'object' && v !== null && 'session_id' in v && typeof v.session_id === 'string', { method: 'POST' })
    return result.session_id
  },
  getSession: (id, signal) => jsonRequest(`/api/v1/sessions/${encodeURIComponent(id)}`, isSession, { signal }),
  async sendMessage(id, input, onEvent, signal) {
    const response = await requireOk(await fetch(new URL(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, window.location.origin), {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(input),
    }))
    await readChatStream(response, onEvent)
  },
  selectOffer: (id, offer, signal) => jsonRequest(`/api/v1/sessions/${encodeURIComponent(id)}/selection`, isOffer, {
    method: 'POST', signal, body: JSON.stringify({ offer_id: offer.offer_id, catalog_version: offer.catalog_version }),
  }),
}
