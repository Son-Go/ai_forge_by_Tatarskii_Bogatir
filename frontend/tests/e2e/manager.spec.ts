import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('manager queue filters, opens context and supports mobile return', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#/manager')
  await expect(page.getByRole('heading', { name: 'Рабочее пространство' })).toBeVisible()
  await expect(page.getByText('Меньше рутины. Больше внимания сложным вопросам.')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Список обращений' }).getByRole('link')).toHaveCount(4)
  // Opening the manager first must not create a client session.
  expect(await page.evaluate(() => localStorage.getItem('softline:mock:session'))).toBeNull()
  await page.screenshot({ path: testInfo.outputPath('manager-queue.png'), fullPage: true, animations: 'disabled' })
  const search = page.getByRole('searchbox', { name: 'Поиск обращений' })
  await search.fill('такого обращения нет')
  await expect(page.getByText('Обращений не найдено')).toBeVisible()
  await expect(page.locator('.queue-empty svg')).toHaveCount(0)
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click()
  await page.getByRole('combobox', { name: 'Статус обращения' }).selectOption('in_progress')
  await expect(page.getByRole('navigation', { name: 'Список обращений' }).getByRole('link')).toHaveCount(1)
  await page.getByRole('combobox', { name: 'Статус обращения' }).selectOption('all')
  await page.getByRole('link', { name: /DEMO-1024/ }).click()
  const detail = page.getByRole('article', { name: 'Обращение DEMO-1024', exact: true })
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('heading', { name: 'Контекст и требования' })).toBeVisible()
  await expect(detail.getByText('Standard запрошена, но не подтверждена каталогом')).toBeVisible()
  await expect(detail.getByRole('article', { name: 'Клиент', exact: true })).toHaveCount(2)
  await expect(detail.getByRole('button', { name: 'Выбрать', exact: true })).toHaveCount(0)
  await expect(page.getByRole('main')).toBeFocused()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate((element) => element.clientWidth))
  await page.screenshot({ path: testInfo.outputPath('manager-case.png'), fullPage: true, animations: 'disabled' })
  await page.reload()
  await expect(detail).toBeVisible()
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('link', { name: 'К очереди', exact: true }).click()
    await expect(search).toBeVisible()
    await page.setViewportSize({ width: 320, height: 568 })
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320)
  }
  expect(errors).toEqual([])
})

test('client has no manual handoff and navigation preserves its draft', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  await input.fill('Какие документы нужны для покупки лицензии?')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.locator('.conversation .sources')).toBeVisible()
  await expect(page.getByText('Каталог и база знаний', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Нужна помощь специалиста?')).toHaveCount(0)
  await expect(page.locator('.handoff, .handoff-form, .system-notice')).toHaveCount(0)
  await input.fill('Мой следующий вопрос')
  await page.getByRole('link', { name: 'Менеджер', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Рабочее пространство' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('softline:demo:handoffs:v1'))).toBeNull()
  await page.getByRole('link', { name: 'Клиент', exact: true }).click()
  await expect(input).toHaveValue('Мой следующий вопрос')
  await expect(page.getByRole('article', { name: 'Вы', exact: true })).toHaveCount(1)
})

test('quote uses the feature flag and confirmed selection and downloads a marked demo PDF', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Подготовить КП' })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Ваше сообщение' }).fill('Подобрать решение на 50 пользователей')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await page.getByRole('button', { name: 'Подготовить КП' }).click()
  const customer = page.getByRole('textbox', { name: 'Наименование заказчика' })
  await expect(customer).toBeFocused()
  await customer.fill('Демонстрационный заказчик')
  await expect(page.getByRole('spinbutton', { name: 'Количество выбранных позиций' })).toHaveValue('1')
  const quoteRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/quote-drafts'))
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать КП' }).click()
  expect((await quoteRequest).postDataJSON()).toEqual({ customer_name: 'Демонстрационный заказчик', quantity: 1 })
  const download = await downloadEvent
  expect(download.suggestedFilename()).toBe('DEMO-quote.pdf')
  const path = testInfo.outputPath('demo-quote.pdf')
  await download.saveAs(path)
  expect(await download.failure()).toBeNull()
  const content = await readFile(path, 'utf8')
  expect(content.startsWith('%PDF-')).toBe(true)
  expect(content).toContain('NO COMMERCIAL VALIDITY')
  await expect(page.getByRole('status').filter({ hasText: 'Скачивание начато' })).toBeVisible()
})

test('switching sections during generation preserves the existing SSE operation', async ({ page }) => {
  // Hold the real mock response after its first delta. A short response can finish
  // between browser assertions; the gate makes the active-stream condition explicit.
  // This changes delivery timing only in this test, not the app or SSE payloads.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    const gate = new Promise<void>((resolve) => window.addEventListener('test:release-stream', () => resolve(), { once: true }))
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!new URL(url, location.origin).pathname.endsWith('/messages') || !response.body) return response
      const root = document.documentElement
      root.dataset.messageRequests = String(Number(root.dataset.messageRequests || '0') + 1)
      root.dataset.streamAborts = '0'
      init?.signal?.addEventListener('abort', () => { root.dataset.streamAborts = String(Number(root.dataset.streamAborts) + 1) }, { once: true })
      const decoder = new TextDecoder()
      let prefix = '', held = false
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          prefix += decoder.decode(chunk, { stream: true })
          controller.enqueue(chunk)
          if (!held && prefix.includes('event: delta')) { held = true; await gate }
        },
      })), { status: response.status, statusText: response.statusText, headers: response.headers })
    }
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await page.getByRole('textbox').fill('Подобрать решение на 50 пользователей')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.getByRole('article', { name: 'Ответ формируется' })).toBeVisible()
  await page.getByRole('link', { name: 'Менеджер', exact: true }).click()
  await page.getByRole('link', { name: 'Клиент', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-stream-aborts', '0')
  await expect(page.locator('html')).toHaveAttribute('data-message-requests', '1')
  await page.evaluate(() => window.dispatchEvent(new Event('test:release-stream')))
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  await expect(page.getByRole('article', { name: 'Вы', exact: true })).toHaveCount(1)
})

for (const theme of ['light', 'dark'] as const) {
  test(`completed cases have a read-only timeline in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/#/manager')
    await expect(page.getByRole('heading', { name: 'Рабочее пространство' })).toBeVisible()
    if (testInfo.project.name === 'desktop') await expect(page.getByRole('heading', { name: 'Выберите обращение' })).toBeVisible()
    if (theme === 'light') await page.getByRole('button', { name: 'Включить светлую тему' }).click()
    await page.getByRole('combobox', { name: 'Статус обращения' }).selectOption('resolved')
    const cases = page.getByRole('navigation', { name: 'Список обращений' })
    await expect(cases.getByRole('link')).toHaveCount(1)
    await expect(cases.getByText('Завершено', { exact: true })).toBeVisible()
    await cases.getByRole('link', { name: /DEMO-1021/ }).click()
    const timeline = page.getByRole('list', { name: 'Хронология обращения' })
    await expect(timeline).toBeVisible()
    await expect(timeline.getByRole('listitem')).toHaveCount(2)
    await expect(timeline.getByText('Действие менеджера', { exact: true })).toHaveCount(0)
    await expect(timeline.getByText('Документ', { exact: true })).toHaveCount(0)
    await expect(timeline.getByRole('button')).toHaveCount(0)
    await expect(timeline.getByRole('link')).toHaveCount(0)
    const timestamps = await timeline.locator('time').evaluateAll((elements) => elements.map((el) => el.getAttribute('datetime')!))
    expect(timestamps).toEqual([...timestamps].sort())
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate((el) => el.clientWidth))
    await expect(page.locator('.case-detail')).toHaveCSS('animation-name', 'none')
    await page.screenshot({ path: testInfo.outputPath(`completed-${theme}.png`), fullPage: true, animations: 'disabled' })
  })
}

test('status dropdown stays compact and inside the queue in both themes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/manager')
  const select = page.getByRole('combobox', { name: 'Статус обращения' })
  await expect(select).toBeVisible()
  await expect(select.getByRole('option')).toHaveCount(4)
  for (const width of [1280, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /Включить .* тему/ }).click()
      const box = (await select.boundingBox())!, parent = (await page.locator('.case-queue').boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(190)
      expect(box.width).toBeLessThanOrEqual(220)
      expect(box.x).toBeGreaterThan(parent.x + 10)
      expect(box.x + box.width).toBeLessThan(parent.x + parent.width - 10)
      await select.press('Space')
      await expect(page.locator('.queue-filters select:open')).toBeVisible()
      expect(await select.evaluate((element) => getComputedStyle(element, '::picker(select)').appearance)).toBe('base-select')
      await page.keyboard.press('Escape')
      await expect(page.locator('.queue-filters select:open')).toHaveCount(0)
      for (const [status, count] of [['queued', 2], ['in_progress', 1], ['resolved', 1], ['all', 4]] as const) {
        await select.selectOption(status)
        await expect(select).toHaveValue(status)
        await expect(page.locator('.case-item')).toHaveCount(count)
      }
      await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width)
    }
  }
})
