import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { requestQuoteDraft } from './quoteApi'

it('uses the existing same-origin POST contract and accepts a validated PDF', async () => {
  let request: Request | undefined
  server.use(http.post('/api/v1/sessions/:id/quote-drafts', ({ request: incoming }) => {
    request = incoming
    return new HttpResponse('%PDF-1.4\n% test', { headers: { 'Content-Type': 'application/pdf' } })
  }))
  const blob = await requestQuoteDraft('demo-session', new AbortController().signal)
  expect(await blob.text()).toContain('%PDF-')
  expect(request!.method).toBe('POST')
  expect(request!.credentials).toBe('same-origin')
  expect(request!.headers.get('Accept')).toBe('application/pdf')
})
it('rejects non-PDF payloads and propagates offer changes without an automatic repeat', async () => {
  server.use(http.post('/api/v1/sessions/:id/quote-drafts', () => new HttpResponse('bad', { headers: { 'Content-Type': 'application/pdf' } })))
  await expect(requestQuoteDraft('s', new AbortController().signal)).rejects.toThrow('некорректный PDF')
  let calls = 0
  server.use(http.post('/api/v1/sessions/:id/quote-drafts', () => { calls++; return HttpResponse.json({ code: 'OFFER_CHANGED', message: 'Изменилось', request_id: 'demo' }, { status: 409 }) }))
  await expect(requestQuoteDraft('s', new AbortController().signal)).rejects.toMatchObject({ status: 409, body: { code: 'OFFER_CHANGED' } })
  expect(calls).toBe(1)
})
