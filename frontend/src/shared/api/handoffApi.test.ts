import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { handoffApi, isAssignedHandoff, isHandoff } from './handoffApi'
import { isMessage } from './guards'

afterEach(() => vi.restoreAllMocks())

const id = '22222222-2222-4222-8222-222222222222'
const item = { handoff_id: id, session_id: id, reason: 'document_review', status: 'queued', created_at: '2026-11-27T08:00:00Z' }
it('separates Bearer manager access from the session cookie and validates all mutation replies', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const calls: Request[] = []
  server.use(http.all('/api/v1/manager/handoffs/*', ({ request }) => {
    calls.push(request)
    return HttpResponse.json({ ...item, status: request.url.endsWith('/resolve') ? 'resolved' : 'in_progress' })
  }))
  const signal = new AbortController().signal
  expect((await handoffApi.claim('synthetic-token', id, signal)).status).toBe('in_progress')
  expect((await handoffApi.resolve('synthetic-token', id, signal)).status).toBe('resolved')
  expect(calls).toHaveLength(2)
  for (const [, init] of fetchSpy.mock.calls) expect(init?.credentials).toBe('omit')
  for (const call of calls) {
    expect(call.headers.get('Authorization')).toBe('Bearer synthetic-token')
    expect(call.method).toBe('POST')
    expect(await call.text()).toBe('')
  }
})
it('reads a nullable session handoff with same-origin credentials and no Bearer', async () => {
  let request: Request | undefined
  server.use(http.get('/api/v1/sessions/:id/handoff', ({ request: input }) => { request = input; return HttpResponse.json({ handoff: null }) }))
  expect(await handoffApi.getSession(id, new AbortController().signal)).toEqual({ handoff: null })
  expect(request!.credentials).toBe('same-origin')
  expect(request!.headers.has('Authorization')).toBe(false)
})
it('rejects invented statuses, event-only histories and invalid sender values', () => {
  expect(isHandoff({ ...item, status: 'completed' })).toBe(false)
  expect(isHandoff({ ...item, reason: 'price' })).toBe(false)
  expect(isAssignedHandoff({ handoff: item, events: [] })).toBe(false)
  const message = { id, role: 'assistant', text: 'Ответ', cards: [], sources: [], status: 'complete', created_at: item.created_at, sender: 'manager' }
  expect(isMessage(message)).toBe(true)
  expect(isMessage({ ...message, sender: 'invented' })).toBe(false)
  expect(isMessage({ ...message, role: 'user' })).toBe(false)
})
