import { expect, test, type Page } from '@playwright/test'
import type { Message, Offer, Source } from '../../src/shared/api/types'

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
    if (url.pathname.endsWith('/faq')) { await route.fulfill({ json: { candidate: null } }); return }
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
  const offer = { offer_id: 'test-offer', catalog_version: sessionId, name: 'Тестовая лицензия на 50 пользователей', product_url: 'https://example.com/product', price: { amount: '12000', currency: 'RUB' }, availability: 'available', selectable: true, attributes: { seats: 50 }, source_ids: [] }
  let fail = true
  let requests = 0
  let approval = false
  let offerChanged = false
  let quoteId = caseId
  let testPayment = false
  let selectedOffer = offer
  const updatedOffer = { ...offer, catalog_version: caseId, price: { amount: '13000', currency: 'RUB' }, name: 'Лицензия с обновлённой ценой' }
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
          updated_offer: updatedOffer } }); return
      }
      invoiceRequests.push(input.quote_id)
      await route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n% SYNTHETIC INVOICE PDF',
        headers: { 'X-Invoice-Purpose': testPayment ? 'test_payment' : 'agreement' } }); return
    }
    if (path.endsWith('/selection')) {
      expect(request.postDataJSON()).toEqual({ offer_id: offer.offer_id, catalog_version: updatedOffer.catalog_version })
      selectedOffer = updatedOffer
      await route.fulfill({ json: updatedOffer }); return
    }
    if (path.endsWith('/handoff')) { await route.fulfill({ json: { handoff: null } }); return }
    if (request.method() === 'POST') { await route.fulfill({ status: 201, json: { session_id: sessionId } }); return }
    await route.fulfill({ json: { session_id: sessionId, last_turn: null, quotes_enabled: true, selected_offer: selectedOffer, messages: [{ ...message('Тестовая рекомендация'), cards: [offer] }] } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Сформировать КП', exact: true }).click()
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
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', page.viewportSize()!.width)
  const invoice = page.getByRole('button', { name: 'Скачать счёт для согласования' })
  await expect(invoice).toHaveCount(0)
  const issuedDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Одобрить КП и получить счёт' }).click()
  expect((await issuedDownload).suggestedFilename()).toBe('invoice-for-review.pdf')
  await expect(page.getByText('Счёт для согласования. Оплата по этому документу не предусмотрена.')).toBeVisible()
  const repeatedDownload = page.waitForEvent('download')
  await invoice.click()
  expect((await repeatedDownload).suggestedFilename()).toBe('invoice-for-review.pdf')
  expect(invoiceRequests).toEqual([caseId, caseId])
  quoteId = crypto.randomUUID()
  approval = false
  const newDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать КП', exact: true }).click()
  await newDownload
  offerChanged = true
  await page.getByRole('button', { name: 'Одобрить КП и получить счёт' }).click()
  await expect(page.getByRole('heading', { name: 'Обновлённое предложение' })).toBeVisible()
  await expect(page.getByText('Лицензия с обновлённой ценой', { exact: true })).toBeVisible()
  await expect(invoice).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Одобрить КП и получить счёт' })).toHaveCount(0)
  await page.getByRole('article', { name: updatedOffer.name }).getByRole('button', { name: 'Выбрать', exact: true }).click()
  await page.getByRole('button', { name: 'Сформировать КП', exact: true }).click()
  await customer.fill('Синтетический заказчик')
  offerChanged = false
  approval = false
  quoteId = crypto.randomUUID()
  const updatedQuoteDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать КП', exact: true }).click()
  await updatedQuoteDownload
  await expect(invoice).toHaveCount(0)
  expect(approval).toBe(false)
  expect(invoiceRequests).toEqual([caseId, caseId])
  testPayment = true
  const updatedInvoiceDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Одобрить КП и получить счёт' }).click()
  expect((await updatedInvoiceDownload).suggestedFilename()).toBe('test-payment-invoice.pdf')
  await expect(page.getByRole('button', { name: 'Скачать тестовый счёт на оплату' })).toBeVisible()
  expect(invoiceRequests).toEqual([caseId, caseId, quoteId])
})

const directSource: Source = { id: 'synthetic-template-source', title: 'Тестовый источник Java', kind: 'catalog', url: 'https://example.com/mdaemon', snapshot_at: at }
const directOffer: Offer = { offer_id: 'synthetic-mdaemon', catalog_version: sessionId, name: 'MDaemon — тестовое продление на 50 пользователей', product_url: directSource.url,
  price: { amount: '100', currency: 'RUB' }, availability: 'unavailable', selectable: true, attributes: { seats: 50, license_term_months: 12 }, source_ids: [directSource.id] }

for (const sequence of ['searching-delta-done', 'delta-done', 'done-only'] as const) {
  test(`Java template ${sequence}: authoritative done text, cards and sources end generation and survive reload`, async ({ page }) => {
    const reply: Message = { id: crypto.randomUUID(), role: 'assistant', status: 'complete', created_at: at, text: 'Нашёл продление MDaemon на 50 пользователей. Проверьте срок лицензии в карточке.', cards: [directOffer], sources: [directSource] }
    const messages: Message[] = []
    let posted = false
    let posts = 0
    let releaseHistory!: () => void
    const history = new Promise<void>((resolve) => { releaseHistory = resolve })
    await page.route('**/api/v1/sessions**', async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path.endsWith('/handoff')) { await route.fulfill({ json: { handoff: null } }); return }
      if (path.endsWith('/messages')) {
        posted = true; posts++
        const input = request.postDataJSON()
        const user: Message = { id: crypto.randomUUID(), role: 'user', text: input.text, status: 'complete', created_at: at, cards: [], sources: [] }
        messages.push(user, reply)
        const events = [
          ['accepted', { turn_id: caseId, client_message_id: input.client_message_id, user_message_id: user.id, request_id: 'synthetic-direct' }],
          ...(sequence === 'searching-delta-done' ? [['status', { stage: 'searching' }]] : []),
          ...(sequence !== 'done-only' ? [['delta', { seq: 1, text: 'Промежуточная фраза, заменяемая итоговым сообщением.' }]] : []),
          ['done', { turn_id: caseId, outcome: 'recommend', message: reply }],
        ]
        await route.fulfill({ contentType: 'text/event-stream', body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') }); return
      }
      if (request.method() === 'POST') { await route.fulfill({ status: 201, json: { session_id: sessionId } }); return }
      if (posted) await history
      await route.fulfill({ json: { session_id: sessionId, messages, selected_offer: null, quotes_enabled: false,
        last_turn: posted ? { turn_id: caseId, status: 'complete', outcome: 'recommend' } : null } })
    })
    await page.goto('/')
    const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
    await input.fill('Нужно продление MDaemon на 50 пользователей')
    await page.getByRole('button', { name: 'Отправить', exact: true }).click()
    // Hold GET history: this must be the actual done.message, not a later GET fix-up.
    const answer = page.getByRole('article', { name: 'Консультант', exact: true })
    await expect(answer.getByText(reply.text, { exact: true })).toBeVisible()
    await expect(answer.getByRole('article', { name: directOffer.name })).toBeVisible()
    await expect(answer.getByRole('link', { name: directSource.title })).toHaveAttribute('href', directSource.url)
    await expect(page.getByRole('article', { name: 'Ответ формируется' })).toHaveCount(0)
    await expect(page.getByText('Промежуточная фраза, заменяемая итоговым сообщением.', { exact: true })).toHaveCount(0)
    releaseHistory()
    await expect(input).toBeEnabled()
    await expect(page.locator('.turn-status .spinner')).toHaveCount(0)
    await expect(answer).toHaveCount(1)
    await page.reload()
    await expect(answer.getByText(reply.text, { exact: true })).toBeVisible()
    await expect(answer.getByRole('link', { name: directSource.title })).toHaveAttribute('href', directSource.url)
    await expect(answer.getByRole('article', { name: directOffer.name })).toBeVisible()
    await expect(input).toBeEnabled()
    expect(posts).toBe(1)
  })
}

test('insufficient_data preserves the edition caveat beside family cards and never infers selection permission', async ({ page }) => {
  const text = 'В каталоге есть продления MDaemon на 50 пользователей. Редакцию Standard подтвердить не удалось. Если знаете артикул, напишите его.'
  const denied = { ...directOffer, offer_id: 'synthetic-denied', name: 'Тестовое семейство без разрешения Java', availability: 'available', selectable: false }
  const legacy = { ...directOffer, offer_id: 'synthetic-no-permission', name: 'Тестовая карточка без флага выбора', selectable: undefined }
  const reply = { ...message(text), cards: [directOffer, denied, legacy], sources: [directSource] }
  let selected: Offer | null = null
  const selections: unknown[] = []
  await page.route('**/api/v1/sessions**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/handoff')) { await route.fulfill({ json: { handoff: null } }); return }
    if (path.endsWith('/selection')) {
      selections.push(request.postDataJSON())
      expect(request.postDataJSON()).toEqual({ offer_id: directOffer.offer_id, catalog_version: directOffer.catalog_version })
      selected = directOffer
      await route.fulfill({ json: selected }); return
    }
    if (request.method() === 'POST') { await route.fulfill({ status: 201, json: { session_id: sessionId } }); return }
    await route.fulfill({ json: { session_id: sessionId, messages: [reply], selected_offer: selected, quotes_enabled: false,
      last_turn: { turn_id: caseId, status: 'complete', outcome: 'insufficient_data' } } })
  })
  await page.goto('/')
  const answer = page.getByRole('article', { name: 'Консультант', exact: true })
  for (let visit = 0; visit < 2; visit++) {
    await expect(answer.getByText(text, { exact: true })).toBeVisible()
    await expect(answer.getByRole('link', { name: directSource.title })).toHaveAttribute('href', directSource.url)
    await expect(answer.getByRole('article', { name: denied.name }).getByRole('button', { name: 'Выбрать', exact: true })).toBeDisabled()
    await expect(answer.getByRole('article', { name: legacy.name }).getByRole('button', { name: 'Выбрать', exact: true })).toBeDisabled()
    await expect(answer.getByRole('article', { name: directOffer.name }).getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
    if (visit === 0) await page.reload()
  }
  expect(selections).toHaveLength(0)
  await answer.getByRole('article', { name: directOffer.name }).getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(answer.getByRole('button', { name: 'Выбрано', exact: true })).toBeDisabled()
  expect(selections).toHaveLength(1)
  await expect(answer.getByText(text, { exact: true })).toBeVisible()
})
