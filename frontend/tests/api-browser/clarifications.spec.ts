import { expect, test, type Page } from '@playwright/test'
import type { Session, Offer, Source } from '../../src/shared/api/types'
import type { Handoff, QueueItem, AssignedHandoff } from '../../src/shared/api/handoffApi'

// All payloads below use the checked-in public/manager contracts. No extra action,
// invoice, discount or timeline routes are simulated.
const sessionId = '11111111-1111-4111-8111-111111111111'
const caseId = '22222222-2222-4222-8222-222222222222'
const secondCaseId = '33333333-3333-4333-8333-333333333333'
const quoteId = '44444444-4444-4444-8444-444444444444'
const nextVersion = '55555555-5555-4555-8555-555555555555'
const at = '2026-11-27T10:00:00Z'
const source: Source = { id: 'synthetic-instruction', title: 'Тестовая инструкция из справки', kind: 'knowledge', url: 'https://example.com/help/activation', checked_at: at }
const message = (role: 'assistant' | 'user', text: string, extras: Partial<Session['messages'][number]> = {}): Session['messages'][number] =>
  ({ id: crypto.randomUUID(), role, text, status: 'complete', cards: [], sources: [], created_at: at, ...extras })
const offer: Offer = { offer_id: 'synthetic-license', catalog_version: sessionId, name: 'Тестовая лицензия с ценой', price: { amount: '21000.13', currency: 'RUB' },
  availability: 'unavailable', selectable: true, product_url: 'https://example.com/product', attributes: { seats: 50 }, source_ids: [] }

async function screenshotThemes(page: Page, outputPath: (name: string) => string, prefix: string) {
  for (const theme of ['dark', 'light']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /Включить .* тему/ }).click()
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', page.viewportSize()!.width)
    await page.screenshot({ path: outputPath(`${prefix}-${theme}.png`), fullPage: true, animations: 'disabled' })
  }
}

for (const topic of ['key_delivery', 'key_activation', 'refund'] as const) {
  test(`support ${topic}: source, ordinary feedback, authoritative handoff and restored history`, async ({ page }, info) => {
    const instruction = message('assistant', 'Тестовая инструкция: выполните действия из справки.', { sources: [source] })
    const session: Session = { session_id: sessionId, messages: [message('user', 'Нужна помощь после покупки'), instruction], selected_offer: null,
      last_turn: { turn_id: quoteId, status: 'complete', outcome: 'answer' }, quotes_enabled: false, support_topic: topic }
    let handoff: Handoff | null = null
    let sent = false
    let readsAfterFeedback = 0
    const inputs: Record<string, unknown>[] = []
    let releaseHandoff!: () => void
    const confirmation = new Promise<void>((resolve) => { releaseHandoff = resolve })
    await page.route('**/api/v1/sessions**', async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path.endsWith('/handoff')) {
        if (sent) { readsAfterFeedback++; await confirmation }
        await route.fulfill({ json: { handoff } }); return
      }
      if (path.endsWith('/messages')) {
        const input = request.postDataJSON() as Record<string, unknown>
        inputs.push(input)
        expect(Object.keys(input).sort()).toEqual(['client_message_id', 'text'])
        expect(input.text).toBe('Не помогло')
        const user = message('user', String(input.text)), reply = message('assistant', 'Сервер принял уточнение.')
        session.messages.push(user, reply)
        session.last_turn = { turn_id: nextVersion, status: 'complete', outcome: 'answer' }
        sent = true
        const body = `event: accepted\ndata: ${JSON.stringify({ turn_id: nextVersion, client_message_id: input.client_message_id, user_message_id: user.id, request_id: 'synthetic-support' })}\n\nevent: done\ndata: ${JSON.stringify({ turn_id: nextVersion, outcome: 'answer', message: reply })}\n\n`
        await route.fulfill({ contentType: 'text/event-stream', body }); return
      }
      expect(path).toBe(request.method() === 'POST' ? '/api/v1/sessions' : `/api/v1/sessions/${sessionId}`)
      await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: request.method() === 'POST' ? { session_id: sessionId } : session })
    })
    await page.goto('/')
    await expect(page.getByRole('link', { name: source.title })).toHaveAttribute('href', source.url)
    const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
    await input.fill('Черновик уточнения, который нужно сохранить')
    await page.getByRole('button', { name: 'Не помогло', exact: true }).click()
    await expect.poll(() => readsAfterFeedback).toBeGreaterThan(0)
    await expect(input).toHaveValue('Черновик уточнения, который нужно сохранить')
    await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toHaveCount(0)
    handoff = { handoff_id: caseId, reason: 'instruction_failed', status: 'queued', created_at: at }
    releaseHandoff()
    await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toContainText('Ожидаем специалиста')
    await expect(page.getByRole('button', { name: 'Не помогло', exact: true })).toHaveCount(0)
    expect(inputs).toHaveLength(1)
    await page.reload()
    await expect(page.getByRole('link', { name: source.title })).toHaveAttribute('href', source.url)
    await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toContainText('Ожидаем специалиста')
    await expect(page.getByRole('button', { name: 'Не помогло', exact: true })).toHaveCount(0)
    expect(inputs).toHaveLength(1)
    if (topic === 'key_activation') await screenshotThemes(page, info.outputPath.bind(info), 'client-support')
  })
}

test('unavailable offers use server permission, re-confirm changes and show server price terms', async ({ page }, info) => {
  const blocked = { ...offer, offer_id: 'blocked', name: 'Выбор запрещён сервером', selectable: false }
  const updated = { ...offer, catalog_version: nextVersion, name: 'Лицензия с обновлёнными условиями' }
  const session: Session = { session_id: sessionId, messages: [message('user', 'Подберите лицензию'), message('assistant', 'Тестовые позиции из каталога', { cards: [blocked, offer] })],
    selected_offer: null, last_turn: { turn_id: quoteId, status: 'complete', outcome: 'recommend' }, quotes_enabled: true }
  const selections: { offer_id: string; catalog_version: string }[] = []
  await page.route('**/api/v1/sessions**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/handoff')) { await route.fulfill({ json: { handoff: null } }); return }
    if (path.endsWith('/selection')) {
      const input = request.postDataJSON() as { offer_id: string; catalog_version: string }
      selections.push(input)
      if (selections.length === 1) { await route.fulfill({ status: 409, json: { code: 'OFFER_CHANGED', message: 'Подтвердите обновлённое предложение', request_id: 'synthetic-selection', updated_offer: updated } }); return }
      expect(input).toEqual({ offer_id: offer.offer_id, catalog_version: nextVersion })
      session.selected_offer = updated
      session.price_terms = { base_amount: '21000.13', discount_percent: '4.25', final_amount: '20107.62', currency: 'RUB' }
      await route.fulfill({ json: updated }); return
    }
    expect(path).toBe(request.method() === 'POST' ? '/api/v1/sessions' : `/api/v1/sessions/${sessionId}`)
    await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: request.method() === 'POST' ? { session_id: sessionId } : session })
  })
  await page.goto('/')
  await expect(page.getByRole('article', { name: blocked.name }).getByRole('button', { name: 'Выбрать', exact: true })).toBeDisabled()
  const allowed = page.getByRole('article', { name: offer.name })
  await expect(allowed).toContainText(/21\s*000,13/)
  await expect(allowed).toContainText(/фид/i)
  await allowed.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обновлённое предложение' })).toBeVisible()
  expect(selections).toHaveLength(1)
  await page.getByRole('article', { name: updated.name }).getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(page.getByRole('article', { name: updated.name }).getByRole('button', { name: 'Выбрано', exact: true })).toBeDisabled()
  const terms = page.getByRole('region', { name: 'Условия предложения' })
  await expect(terms).toContainText('4.25%')
  const text = (await terms.innerText()).replace(/\s/g, '')
  expect(text).toMatch(/21000[.,]13/)
  expect(text).toMatch(/20107[.,]62/)
  expect(selections).toHaveLength(2)
  await screenshotThemes(page, info.outputPath.bind(info), 'client-price-terms')
  await page.setViewportSize({ width: 320, height: 844 })
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320)
})

test('manager reads the two new reasons, instruction history and confirmed commercial terms', async ({ page }, info) => {
  const instruction: QueueItem = { handoff_id: caseId, session_id: sessionId, reason: 'instruction_failed', status: 'in_progress', created_at: at }
  const deferred: QueueItem = { ...instruction, handoff_id: secondCaseId, reason: 'payment_deferral' }
  const instructionDetail: AssignedHandoff = { handoff: instruction, messages: [message('user', 'Не помогло'), message('assistant', 'Тестовая инструкция в истории', { sources: [source] })], sales_context: null }
  const deferredDetail: AssignedHandoff = { handoff: deferred, messages: [message('user', 'Прошу отсрочку оплаты')], sales_context: {
    offer: { ...offer, attributes: {} }, quote: { quote_id: quoteId, quantity: 2, approved: true, price: { amount: '21000.13', currency: 'RUB' }, discount_percent: '4.25', agreed_total: '40215.24' },
  } }
  await page.route('**/api/v1/manager/handoffs**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    expect(request.method()).toBe('GET')
    expect(request.headers().authorization).toBe('Bearer synthetic-clarifications')
    if (path.endsWith(`/${caseId}`)) { await route.fulfill({ json: instructionDetail }); return }
    if (path.endsWith(`/${secondCaseId}`)) { await route.fulfill({ json: deferredDetail }); return }
    expect(path).toBe('/api/v1/manager/handoffs')
    await route.fulfill({ json: [instruction, deferred] })
  })
  await page.goto('/#/manager')
  await page.getByLabel('Токен доступа').fill('synthetic-clarifications')
  await page.getByRole('button', { name: 'Открыть очередь' }).click()
  await page.getByRole('link', { name: new RegExp(caseId) }).click()
  await expect(page.locator('.case-detail .case-heading h2')).toHaveText('Инструкция не помогла')
  await expect(page.locator('.case-transcript')).toContainText('Тестовая инструкция в истории')
  await expect(page.getByRole('link', { name: source.title })).toHaveAttribute('href', source.url)
  await page.getByRole('link', { name: 'К очереди', exact: true }).first().click()
  await page.getByRole('link', { name: new RegExp(secondCaseId) }).click()
  await expect(page.locator('.case-detail .case-heading h2')).toHaveText('Отсрочка оплаты')
  const terms = page.locator('.requirements-grid')
  await expect(terms).toContainText(quoteId)
  await expect(terms).toContainText('КП одобрено')
  await expect(terms).toContainText('4.25%')
  expect((await terms.innerText()).replace(/\s/g, '')).toMatch(/40215[.,]24/)
  await expect(page.locator('.case-detail')).toContainText(offer.name)
  await expect(page.locator('.timeline-event')).toHaveCount(0)
  await screenshotThemes(page, info.outputPath.bind(info), 'manager-sales-context')
})

// These are frontend contract tests, not Java routing tests. Only the simulated
// Java reply supplies coupon outcomes, money and handoff decisions.
async function salesConversation(page: Page, respond: (text: string, index: number) => {
  text: string; terms?: Session['price_terms']; handoff?: Handoff
}, handoffConfirmation?: Promise<void>) {
  const selected: Offer = { ...offer, price: { amount: '100', currency: 'RUB' } }
  const session: Session = { session_id: sessionId, selected_offer: selected, quotes_enabled: false,
    messages: [message('assistant', 'Выбрана тестовая позиция.', { cards: [selected] })], last_turn: null }
  const inputs: string[] = []
  let handoff: Handoff | null = null
  let handoffReadsAfterSend = 0
  await page.route('**/api/v1/sessions**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/handoff')) {
      if (inputs.length) { handoffReadsAfterSend++; await handoffConfirmation }
      await route.fulfill({ json: { handoff } }); return
    }
    if (path.endsWith('/messages')) {
      const input = request.postDataJSON() as { text: string; client_message_id: string }
      expect(Object.keys(input).sort()).toEqual(['client_message_id', 'text'])
      inputs.push(input.text)
      const response = respond(input.text, inputs.length)
      const user = message('user', input.text), reply = message('assistant', response.text)
      const turnId = crypto.randomUUID()
      session.messages.push(user, reply)
      session.last_turn = { turn_id: turnId, status: 'complete', outcome: 'answer' }
      if (response.terms) session.price_terms = response.terms
      handoff = response.handoff ?? null
      const body = `event: accepted\ndata: ${JSON.stringify({ turn_id: turnId, client_message_id: input.client_message_id, user_message_id: user.id, request_id: 'synthetic-sales' })}\n\nevent: done\ndata: ${JSON.stringify({ turn_id: turnId, outcome: 'answer', message: reply })}\n\n`
      await route.fulfill({ contentType: 'text/event-stream', body }); return
    }
    expect(path).toBe(request.method() === 'POST' ? '/api/v1/sessions' : `/api/v1/sessions/${sessionId}`)
    await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: request.method() === 'POST' ? { session_id: sessionId } : session })
  })
  await page.goto('/')
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  await expect(input).toBeEnabled()
  async function send(text: string) {
    await input.fill(text)
    await page.getByRole('button', { name: 'Отправить', exact: true }).click()
    await expect(page.getByRole('article', { name: 'Вы', exact: true }).last()).toContainText(text)
    await expect(input).toBeEnabled()
  }
  return { inputs, send, handoffReadsAfterSend: () => handoffReadsAfterSend }
}

test('short Нет after the coupon question shows Java price terms and restores them without client-side coupon rules', async ({ page }) => {
  const question = 'Есть ли у вас купон или промокод?'
  const scenario = await salesConversation(page, (text, index) => {
    expect(text).toBe(index === 1 ? 'Мне дорого' : 'Нет')
    return index === 1 ? { text: question } : {
      text: 'Сервер подтвердил скидку и условия выбранной позиции.',
      terms: { base_amount: '100', discount_percent: '5', final_amount: '95', currency: 'RUB' },
    }
  })
  const terms = page.getByRole('region', { name: 'Условия предложения' })
  await scenario.send('Мне дорого')
  await expect(page.getByText(question, { exact: true })).toBeVisible()
  await expect(terms).toHaveCount(0)
  await scenario.send('Нет')
  await expect(terms).toContainText('5%')
  await expect(terms.locator('div', { has: page.getByText('Базовая цена', { exact: true }) })).toContainText('100')
  await expect(terms.locator('div', { has: page.getByText('Итого за единицу', { exact: true }) })).toContainText('95')
  await expect.poll(scenario.handoffReadsAfterSend).toBeGreaterThanOrEqual(2)
  await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toHaveCount(0)
  await page.reload()
  await expect(terms).toContainText('5%')
  await expect(terms).toContainText('95')
  expect(scenario.inputs).toEqual(['Мне дорого', 'Нет'])
})

test('price objection and payment in 30 days show the Java handoff in the same turn without proposing a local discount', async ({ page }) => {
  let confirm!: () => void
  const confirmed = new Promise<void>((resolve) => { confirm = resolve })
  const text = 'Мне дорого, можно рассчитаться через 30 дней?'
  const scenario = await salesConversation(page, (input) => {
    expect(input).toBe(text)
    return { text: 'Передаю просьбу об отсрочке специалисту.', handoff: { handoff_id: caseId, reason: 'payment_deferral', status: 'queued', created_at: at } }
  }, confirmed)
  await scenario.send(text)
  await expect.poll(scenario.handoffReadsAfterSend).toBeGreaterThan(0)
  const notice = page.getByRole('status', { name: 'Автоматическая передача обращения' })
  await expect(notice).toHaveCount(0)
  confirm()
  await expect(notice).toContainText('Ожидаем специалиста')
  await expect(notice).toContainText(caseId)
  await expect(page.getByRole('region', { name: 'Условия предложения' })).toHaveCount(0)
  expect(scenario.inputs).toEqual([text])
  await page.reload()
  await expect(notice).toContainText('Ожидаем специалиста')
  expect(scenario.inputs).toHaveLength(1)
})

test('Отсрочка нам не нужна remains an ordinary message when Java returns no handoff', async ({ page }) => {
  const text = 'Отсрочка нам не нужна'
  const scenario = await salesConversation(page, (input) => {
    expect(input).toBe(text)
    return { text: 'Продолжим обсуждение выбранного предложения.' }
  })
  await scenario.send(text)
  await expect(page.getByText('Продолжим обсуждение выбранного предложения.', { exact: true })).toBeVisible()
  await expect.poll(scenario.handoffReadsAfterSend).toBeGreaterThan(0)
  await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Условия предложения' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('status', { name: 'Автоматическая передача обращения' })).toHaveCount(0)
  expect(scenario.inputs).toEqual([text])
})
