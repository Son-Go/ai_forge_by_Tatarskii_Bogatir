import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { requestQuoteDraft } from './quoteApi'

it('uses the existing same-origin POST contract and accepts a validated PDF', async () => {
  let request: Request | undefined
  let body: unknown
  server.use(http.post('/api/v1/sessions/:id/quote-drafts', async ({ request: incoming }) => {
    request = incoming
    body = await incoming.json()
    return new HttpResponse('%PDF-1.4\n% test', { headers: { 'Content-Type': 'application/pdf' } })
  }))
  const { blob } = await requestQuoteDraft('demo-session', { customer_name: '  Демо заказчик  ', quantity: 1 }, new AbortController().signal)
  expect(await blob.text()).toContain('%PDF-')
  expect(request!.method).toBe('POST')
  expect(request!.credentials).toBe('same-origin')
  expect(request!.headers.get('Accept')).toBe('application/pdf')
  expect(request!.headers.get('Content-Type')).toBe('application/json')
  expect(body).toEqual({ customer_name: 'Демо заказчик', quantity: 1 })
})
it('rejects non-PDF payloads and propagates offer changes without an automatic repeat', async () => {
  server.use(http.post('/api/v1/sessions/:id/quote-drafts', () => new HttpResponse('bad', { headers: { 'Content-Type': 'application/pdf' } })))
  await expect(requestQuoteDraft('s', { customer_name: 'Демо', quantity: 1 }, new AbortController().signal)).rejects.toThrow('некорректный PDF')
  let calls = 0
  server.use(http.post('/api/v1/sessions/:id/quote-drafts', () => { calls++; return HttpResponse.json({ code: 'OFFER_CHANGED', message: 'Изменилось', request_id: 'demo' }, { status: 409 }) }))
  await expect(requestQuoteDraft('s', { customer_name: 'Демо', quantity: 1 }, new AbortController().signal)).rejects.toMatchObject({ status: 409, body: { code: 'OFFER_CHANGED' } })
  expect(calls).toBe(1)
})

it('rejects blank customers and fractional or invalid position quantities before HTTP', async () => {
  let calls = 0
  server.use(http.post('/api/v1/sessions/:id/quote-drafts', () => { calls++; return new HttpResponse('') }))
  for (const input of [{ customer_name: '  ', quantity: 1 }, { customer_name: 'A'.repeat(161), quantity: 1 }, ...[0, -1, 1.5, 100000, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((quantity) => ({ customer_name: 'Демо', quantity }))]) {
    await expect(requestQuoteDraft('s', input, new AbortController().signal)).rejects.toThrow()
  }
  expect(calls).toBe(0)
})
