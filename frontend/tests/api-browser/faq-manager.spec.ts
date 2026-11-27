import { expect, test } from '@playwright/test'

test('FAQ is limited to an accessible closed case and never fabricates a candidate request', async ({ page }) => {
  const id = '22222222-2222-4222-8222-222222222222'
  const handoff = { handoff_id: id, session_id: '11111111-1111-4111-8111-111111111111', reason: 'document_review', status: 'in_progress', created_at: '2026-11-27T10:00:00Z' }
  const requests: string[] = []
  let accessible = true
  await page.route('**/api/v1/manager/**', async (route) => {
    const request = route.request(), url = new URL(request.url())
    expect(request.headers().authorization).toBe('Bearer synthetic-faq-test')
    requests.push(`${request.method()} ${url.pathname}`)
    if (url.pathname.endsWith(`/${id}`)) {
      await route.fulfill(accessible ? { json: { handoff, messages: [] } } : { status: 404, json: { code: 'TEST_NOT_FOUND', message: 'Тестовое обращение недоступно', request_id: 'synthetic-test' } })
      return
    }
    if (url.pathname.endsWith('/resolve')) { handoff.status = 'resolved'; await route.fulfill({ json: handoff }); return }
    expect(url.pathname).toBe('/api/v1/manager/handoffs')
    await route.fulfill({ json: [handoff] })
  })
  await page.goto('/#/manager')
  await expect(page.getByRole('region', { name: 'Ответ для FAQ' })).toHaveCount(0)
  await page.getByLabel('Токен доступа').fill('synthetic-faq-test')
  await page.getByRole('button', { name: 'Открыть очередь' }).click()
  await page.getByRole('link', { name: new RegExp(id) }).click()
  await expect(page.getByRole('button', { name: 'Завершить обращение' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Ответ для FAQ' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Завершить обращение' }).click()
  const panel = page.getByRole('region', { name: 'Ответ для FAQ' })
  await expect(panel).toContainText('Данные проверки FAQ пока недоступны.')
  await expect(panel.getByRole('status')).toHaveCount(0)
  await expect(panel.getByRole('button')).toHaveCount(0)
  await page.getByRole('button', { name: 'Включить светлую тему' }).click()
  await expect(panel).toBeVisible()
  accessible = false
  // Closed-case detail polling already stops in the app. Re-open to recheck access.
  await page.getByRole('link', { name: 'К очереди', exact: true }).first().click()
  await page.getByRole('link', { name: new RegExp(id) }).click()
  await expect(page.getByRole('alert')).toContainText('Контекст недоступен')
  await expect(panel).toHaveCount(0)
  expect(requests.every((request) => /^(GET \/api\/v1\/manager\/handoffs(?:\/[\da-f-]+)?|POST \/api\/v1\/manager\/handoffs\/[\da-f-]+\/resolve)$/.test(request))).toBe(true)
})
