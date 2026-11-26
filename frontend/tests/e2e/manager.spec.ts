import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('manager queue filters, opens context and supports mobile return', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/#/manager')
  await expect(page.getByRole('heading', { name: 'Рабочее пространство' })).toBeVisible()
  await expect(page.getByText('Меньше рутины. Больше внимания сложным вопросам.')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Список обращений' }).getByRole('link')).toHaveCount(3)
  // Opening the manager first must not create a client session.
  expect(await page.evaluate(() => localStorage.getItem('softline:mock:session'))).toBeNull()
  await page.screenshot({ path: testInfo.outputPath('manager-queue.png'), fullPage: true, animations: 'disabled' })
  const search = page.getByRole('searchbox', { name: 'Поиск обращений' })
  await search.fill('такого обращения нет')
  await expect(page.getByText('Обращений не найдено')).toBeVisible()
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click()
  await page.getByRole('button', { name: 'В работе', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Список обращений' }).getByRole('link')).toHaveCount(1)
  await page.getByRole('button', { name: 'Все', exact: true }).click()
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

test('local demo handoff carries the exact client context and navigation preserves a draft', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  await input.fill('Проверьте нашу справку для академической лицензии')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  const help = page.getByRole('button', { name: 'Нужна помощь специалиста?' })
  await expect(help).toBeEnabled()
  await help.click()
  await page.getByLabel('Что нужно проверить').selectOption('documents')
  await page.getByRole('button', { name: 'Зарегистрировать демообращение' }).click()
  await expect(page.getByText('Реальному сотруднику ничего не отправлялось.', { exact: false })).toBeVisible()
  await input.fill('Мой следующий вопрос')
  await page.getByRole('link', { name: 'Открыть в разделе менеджера' }).click()
  const detail = page.locator('.case-detail')
  await expect(detail.getByRole('heading', { name: 'Проверка документов', exact: true })).toBeVisible()
  await expect(detail.getByRole('article', { name: 'Клиент', exact: true }).getByText('Проверьте нашу справку для академической лицензии', { exact: true })).toBeVisible()
  const location = page.url()
  await page.getByRole('link', { name: 'Клиент', exact: true }).click()
  await expect(input).toHaveValue('Мой следующий вопрос')
  await expect(page.getByRole('article', { name: 'Вы', exact: true })).toHaveCount(1)
  await page.goto(location)
  await expect(detail.getByRole('article', { name: 'Клиент', exact: true }).getByText('Проверьте нашу справку для академической лицензии', { exact: true })).toBeVisible()
})

test('quote uses the feature flag and confirmed selection and downloads a marked demo PDF', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Скачать демочерновик КП' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Подобрать решение', exact: true }).click()
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать демочерновик КП' }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toBe('DEMO-softline-quote-draft.pdf')
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
