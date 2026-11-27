import { expect, test } from '@playwright/test'

test('published FAQ is a normal answer with a source in SSE and restored history', async ({ page }) => {
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const at = '2026-11-27T10:00:00Z'
  const source = { id: 'synthetic-faq-reference', title: 'Синтетическая справка для FAQ', kind: 'knowledge', url: 'https://example.com/support/faq', checked_at: at }
  const reply = { id: '22222222-2222-4222-8222-222222222222', role: 'assistant', text: 'Опубликованный тестовый ответ: общие условия доступны в справке.', status: 'complete', cards: [], sources: [source], created_at: at }
  const user = { id: '33333333-3333-4333-8333-333333333333', role: 'user', text: 'Где найти общие условия покупки?', status: 'complete', cards: [], sources: [], created_at: at }
  let sent = false
  let posts = 0
  await page.route('**/api/v1/sessions**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/handoff')) { await route.fulfill({ json: { handoff: null } }); return }
    if (path.endsWith('/messages')) {
      const input = request.postDataJSON()
      sent = true; posts++
      const body = `event: accepted\ndata: ${JSON.stringify({ turn_id: sessionId, client_message_id: input.client_message_id, user_message_id: user.id, request_id: 'synthetic-test' })}\n\nevent: done\ndata: ${JSON.stringify({ turn_id: sessionId, outcome: 'answer', message: reply })}\n\n`
      await route.fulfill({ contentType: 'text/event-stream', body }); return
    }
    if (request.method() === 'POST') { await route.fulfill({ status: 201, json: { session_id: sessionId } }); return }
    await route.fulfill({ json: { session_id: sessionId, messages: sent ? [user, reply] : [], selected_offer: null, quotes_enabled: false, last_turn: sent ? { turn_id: sessionId, status: 'complete', outcome: 'answer' } : null } })
  })
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Ваше сообщение' }).fill(user.text)
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  const assistant = page.getByRole('article', { name: 'Консультант', exact: true })
  await expect(assistant.getByText(reply.text, { exact: true })).toBeVisible()
  await expect(assistant.getByRole('link', { name: source.title })).toHaveAttribute('href', source.url)
  await page.getByRole('button', { name: 'Включить светлую тему' }).click()
  await page.reload()
  await expect(assistant.getByText(reply.text, { exact: true })).toBeVisible()
  await expect(assistant.getByRole('link', { name: source.title })).toHaveAttribute('href', source.url)
  await expect(page.getByRole('article', { name: 'Вы', exact: true })).toHaveCount(1)
  expect(posts).toBe(1)
})
