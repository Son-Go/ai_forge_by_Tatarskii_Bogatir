import { expect, test, type Page } from '@playwright/test'

const sessionId = '11111111-1111-4111-8111-111111111111'
const caseId = '22222222-2222-4222-8222-222222222222'
const at = '2026-11-27T08:00:00Z'
const item = { handoff_id: caseId, session_id: sessionId, reason: 'document_review', status: 'queued', created_at: at }
const message = (text: string, sender?: 'manager') => ({ id: String(crypto.randomUUID()), role: 'assistant', text, status: 'complete', created_at: at, cards: [], sources: [], ...(sender ? { sender } : {}) })
const error = { code: 'TEST_ERROR', message: 'Синтетическая ошибка тестового API', request_id: 'test-request' }
async function login(page: Page) {
  await page.goto('/#/manager')
  await page.getByLabel('Токен доступа').fill('test-token')
  await page.getByRole('button', { name: 'Открыть очередь' }).click()
}

test('manager claims, reads, retries a reply with the same ID, resolves and retains closed history', async ({ page }, info) => {
  const record = { ...item }
  let assigned = false
  let failFirstReply = true
  const messages = [message('Нужна проверка документов')]
  const replies: { message_id: string; text: string }[] = []
  const reads: string[] = []
  await page.route('**/api/v1/manager/handoffs**', async (route) => {
    const request = route.request(), url = new URL(request.url())
    expect(request.headers().authorization).toBe('Bearer test-token')
    reads.push(`${request.method()} ${url.pathname}`)
    if (url.pathname.endsWith('/claim')) { assigned = true; record.status = 'in_progress'; await route.fulfill({ json: record }); return }
    if (url.pathname.endsWith('/resolve')) { record.status = 'resolved'; await route.fulfill({ json: record }); return }
    if (request.method() === 'POST' && url.pathname.endsWith('/messages')) {
      const input = request.postDataJSON() as { message_id: string; text: string }
      replies.push(input)
      const existing = messages.find((m) => m.id === input.message_id)
      if (!existing) messages.push({ ...message(input.text, 'manager'), id: input.message_id })
      if (failFirstReply) { failFirstReply = false; await route.fulfill({ status: 503, json: error }); return }
      await route.fulfill({ json: messages.find((m) => m.id === input.message_id) }); return
    }
    if (url.pathname.endsWith(`/${caseId}`)) {
      await route.fulfill(assigned ? { json: { handoff: record, messages } } : { status: 404, json: error }); return
    }
    expect(url.searchParams.get('limit')).toBe('51')
    await route.fulfill({ json: [record] })
  })
  await login(page)
  await expect(page.locator('.case-item')).toHaveCount(1)
  await expect(page.getByRole('navigation', { name: 'Страницы очереди' })).toHaveCount(0)
  await page.getByRole('link', { name: new RegExp(caseId) }).click()
  await page.getByRole('button', { name: 'Взять в работу' }).click()
  await expect(page.getByRole('list', { name: 'Хронология обращения' })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Ответ клиенту' })
  await input.fill('Документы проверены · тестовый ответ')
  await page.getByRole('button', { name: 'Отправить ответ', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(error.message)
  await expect(input).toHaveValue('Документы проверены · тестовый ответ')
  await page.getByRole('button', { name: 'Отправить ответ', exact: true }).click()
  await expect(input).toHaveValue('')
  expect(replies).toHaveLength(2)
  expect(replies[0]!.message_id).toBe(replies[1]!.message_id)
  expect(messages.filter((m) => m.sender === 'manager')).toHaveLength(1)
  await expect(page.getByRole('article', { name: 'Специалист', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Завершить обращение' }).click()
  await expect(page.getByRole('textbox', { name: 'Ответ клиенту' })).toHaveCount(0)
  await expect(page.locator('.case-detail .case-status')).toHaveText('Завершено')
  if (info.project.name === 'api-mobile') await page.getByRole('link', { name: 'К очереди', exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Статус обращения' }).selectOption('resolved')
  await expect(page.locator('.case-item')).toHaveCount(1)
  await expect(page.locator('.timeline-event')).toHaveCount(0)
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(storage).not.toContain('test-token')
  expect(reads.some((r) => r.endsWith('/resolve'))).toBe(true)
  await page.screenshot({ path: info.outputPath('manager-api-resolved.png'), fullPage: true, animations: 'disabled' })
})

test('queue paginates loaded pages, polls, handles 401 and rejects malformed responses', async ({ page }) => {
  const offsets: string[] = []
  let mode: 'ok' | 'bad' | 'unauthorized' = 'ok'
  let count = 50
  await page.route('**/api/v1/manager/handoffs**', async (route) => {
    const url = new URL(route.request().url())
    offsets.push(url.searchParams.get('offset')!)
    if (mode === 'unauthorized') { await route.fulfill({ status: 401, json: error }); return }
    if (mode === 'bad') { await route.fulfill({ json: [{ ...item, status: 'invented' }] }); return }
    await route.fulfill({ json: url.searchParams.get('offset') === '0' ? Array.from({ length: count }, (_, i) => ({ ...item, handoff_id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}` })) : [{ ...item, status: 'resolved' }] })
  })
  await login(page)
  await expect(page.locator('.case-item')).toHaveCount(50)
  const previous = page.getByRole('button', { name: 'Назад', exact: true })
  const next = page.getByRole('button', { name: 'Далее', exact: true })
  await expect(previous).toHaveCount(0)
  await expect(next).toHaveCount(0)
  count = 51
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await expect(next).toBeVisible()
  await expect(page.locator('.case-item')).toHaveCount(50)
  await page.getByRole('combobox', { name: 'Статус обращения' }).selectOption('resolved')
  await expect(page.locator('.case-item')).toHaveCount(0)
  await next.click()
  await expect(page.locator('.case-item')).toHaveCount(1)
  expect(offsets).toContain('50')
  await expect(next).toHaveCount(0)
  await previous.click()
  await expect(next).toBeVisible()
  await expect(previous).toHaveCount(0)
  const before = offsets.length
  await expect.poll(() => offsets.length, { timeout: 8000 }).toBeGreaterThan(before)
  mode = 'bad'
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('не соответствует контракту')
  mode = 'unauthorized'
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Доступ менеджера' })).toBeVisible()
  await expect(page.getByLabel('Токен доступа')).toHaveValue('')
  await expect(page.locator('.case-item')).toHaveCount(0)
})

test('client reads Java handoff, receives manager replies, keeps drafting, resolves and returns to AI', async ({ page }) => {
  let handoff: typeof item | null = null
  const messages: ReturnType<typeof message>[] = []
  let turn: { turn_id: string; status: string; outcome: string } | null = null
  const sends: string[] = []
  await page.route('**/api/v1/sessions**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/handoff')) { await route.fulfill({ json: { handoff } }); return }
    if (path.endsWith('/messages')) {
      const input = request.postDataJSON() as { text: string; client_message_id: string }
      sends.push(input.text)
      const user = { ...message(input.text), role: 'user', id: crypto.randomUUID() }
      const answer = message(sends.length === 1 ? 'Запрос передан специалисту для проверки документов.' : 'Снова отвечает ИИ-консультант.')
      messages.push(user, answer)
      if (sends.length === 1) handoff = { ...item }
      turn = { turn_id: crypto.randomUUID(), status: 'complete', outcome: 'answer' }
      const body = `event: accepted\ndata: ${JSON.stringify({ turn_id: turn.turn_id, client_message_id: input.client_message_id, user_message_id: user.id, request_id: 'test' })}\n\nevent: done\ndata: ${JSON.stringify({ turn_id: turn.turn_id, outcome: 'answer', message: answer })}\n\n`
      await route.fulfill({ contentType: 'text/event-stream', body }); return
    }
    if (request.method() === 'POST') { await route.fulfill({ status: 201, json: { session_id: sessionId } }); return }
    await route.fulfill({ json: { session_id: sessionId, messages, last_turn: turn, quotes_enabled: false, selected_offer: null } })
  })
  await page.goto('/')
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  await input.fill('Нужна проверка документов')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toContainText('Ожидаем специалиста')
  await input.fill('Черновик уточнения')
  handoff = { ...item, status: 'in_progress' }
  messages.push(message('Я специалист, проверю условия.', 'manager'))
  await expect(page.getByRole('article', { name: 'Специалист', exact: true })).toBeVisible({ timeout: 8000 })
  await expect(input).toHaveValue('Черновик уточнения')
  await expect(input).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Нужна помощь специалиста?' })).toHaveCount(0)
  await page.getByRole('button', { name: /Включить .* тему/ }).click()
  handoff = { ...item, status: 'resolved' }
  await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toContainText('Обращение завершено', { timeout: 8000 })
  await page.reload()
  await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toContainText('Обращение завершено')
  await input.fill('Продолжим подбор')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.getByText('Снова отвечает ИИ-консультант.', { exact: true })).toBeVisible()
  expect(sends).toHaveLength(2)
})

test('quote sends schema fields, keeps the form after errors and approves the downloaded version before invoice', async ({ page }) => {
  const offer = { offer_id: 'test-offer', catalog_version: sessionId, name: 'Тестовая лицензия на 50 пользователей', product_url: 'https://example.com/product', price: { amount: '12000', currency: 'RUB' }, availability: 'available', attributes: { seats: 50 }, source_ids: [] }
  let fail = true
  let requests = 0
  let approval = false
  let offerChanged = false
  let quoteId = caseId
  const invoiceRequests: string[] = []
  await page.route('**/api/v1/sessions**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/quote-drafts')) {
      requests++
      expect(request.postDataJSON()).toEqual({ customer_name: 'Синтетический заказчик', quantity: 1 })
      if (fail) { await route.fulfill({ status: 503, json: error }); return }
      await route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n% SYNTHETIC TEST PDF',
        headers: { 'X-Quote-Id': quoteId, 'X-Invoice-Drafts-Enabled': 'true' } }); return
    }
    if (path.endsWith(`/quote-drafts/${quoteId}/approval`)) { approval = true; await route.fulfill({ status: 204 }); return }
    if (path.endsWith('/invoice-drafts')) {
      expect(approval).toBe(true)
      const input = request.postDataJSON()
      expect(input).toEqual({ quote_id: quoteId })
      if (offerChanged) {
        await route.fulfill({ status: 409, json: { ...error, code: 'OFFER_CHANGED',
          updated_offer: { ...offer, catalog_version: caseId, name: 'Лицензия с обновлённой ценой' } } }); return
      }
      invoiceRequests.push(input.quote_id)
      await route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n% SYNTHETIC INVOICE PDF' }); return
    }
    if (path.endsWith('/handoff')) { await route.fulfill({ json: { handoff: null } }); return }
    if (request.method() === 'POST') { await route.fulfill({ status: 201, json: { session_id: sessionId } }); return }
    await route.fulfill({ json: { session_id: sessionId, last_turn: null, quotes_enabled: true, selected_offer: offer, messages: [{ ...message('Тестовая рекомендация'), cards: [offer] }] } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Подготовить КП', exact: true }).click()
  const customer = page.getByRole('textbox', { name: 'Наименование заказчика' })
  await expect(customer).toHaveAttribute('maxlength', '160')
  await customer.fill('Синтетический заказчик')
  await expect(page.getByRole('spinbutton')).toHaveValue('1')
  await page.getByRole('button', { name: 'Скачать КП', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(error.message)
  expect(requests).toBe(1)
  await expect(customer).toHaveValue('Синтетический заказчик')
  fail = false
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать КП', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('quote.pdf')
  const invoice = page.getByRole('button', { name: 'Скачать счёт' })
  await expect(invoice).toHaveCount(0)
  await page.getByRole('button', { name: 'Одобрить КП' }).click()
  for (let attempt = 0; attempt < 2; attempt++) {
    const invoiceDownload = page.waitForEvent('download')
    await invoice.click()
    expect((await invoiceDownload).suggestedFilename()).toBe('invoice.pdf')
  }
  expect(invoiceRequests).toEqual([caseId, caseId])
  quoteId = crypto.randomUUID()
  approval = false
  const newDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать КП', exact: true }).click()
  await newDownload
  await page.getByRole('button', { name: 'Одобрить КП' }).click()
  offerChanged = true
  await invoice.click()
  await expect(page.getByRole('heading', { name: 'Обновлённое предложение' })).toBeVisible()
  await expect(page.getByText('Лицензия с обновлённой ценой', { exact: true })).toBeVisible()
  await expect(invoice).toHaveCount(0)
})
