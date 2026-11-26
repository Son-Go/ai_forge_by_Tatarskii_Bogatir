import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener('error', (event) => {
      if (event.message.includes('ResizeObserver')) document.documentElement.setAttribute('data-resize-error', event.message)
    })
  })
})
test.afterEach(async ({ page }) => {
  await expect(page.locator('html')).not.toHaveAttribute('data-resize-error')
})

test('branded welcome remains accessible and responsive', async ({ page }, testInfo) => {
  await page.goto('/')
  const heading = page.getByRole('heading', { name: /Поможем найти/ })
  await expect(heading).toBeVisible()
  await expect(heading).toBeInViewport()
  await expect(page.locator('.workspace-bar').getByRole('button', { name: 'Новый диалог', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Консультант Softline', exact: true })).toBeVisible()
  await expect(page.getByText('Подбор программного обеспечения', { exact: true })).toHaveCount(0)
  await expect(page.locator('.keyboard-hint')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toHaveText('')
  await expect(page.getByRole('link', { name: 'Softline Store — открыть магазин' })).toHaveAttribute('href', 'https://store.softline.ru/')
  for (const name of ['Знаю продукт', 'Подобрать решение', 'Задать вопрос']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('welcome.png'), fullPage: true })

  const ratios = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    function luminance(name: string) {
      const hex = css.getPropertyValue(name).trim().replace('#', '')
      const values = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
      return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722
    }
    return [['--text', '--surface'], ['--muted', '--surface-muted'], ['--accent', '--surface'], ['--warning', '--warning-soft']]
      .map(([a, b]) => { const x = luminance(a!), y = luminance(b!); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) })
  })
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Перейти к консультации' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  await page.getByRole('button', { name: 'Знаю продукт', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ваше сообщение' })).toBeFocused()

  await page.setViewportSize({ width: 320, height: 568 })
  await page.reload()
  await expect(heading).toBeInViewport()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320)
  await page.screenshot({ path: testInfo.outputPath('welcome-compact.png'), fullPage: true })
})

test('loading, error, sources and long card content retain their layout', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const input = page.getByRole('textbox')
  await input.fill('Ошибка модели')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('error.png'), fullPage: true })
  await page.getByRole('button', { name: 'Повторить отправку' }).click()
  await expect(page.getByText('Какой срок лицензии вам нужен?')).toBeVisible()
  await input.fill('Подобрать решение на 50 пользователей')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  await expect(page.getByText('Источники ответа')).toBeVisible()
  await page.getByText('Источники ответа').click()
  await expect(page.locator('.sources')).not.toHaveAttribute('open')
  await page.getByText('Источники ответа').click()
  await expect(page.getByRole('link', { name: 'Демонстрационная карточка' })).toBeVisible()

  // Exercise layout with API-shaped data, without changing production mocks or business logic.
  await page.evaluate(() => {
    const key = 'softline:mock:server'
    const entries = JSON.parse(localStorage.getItem(key) || '[]')
    for (const [, record] of entries) for (const message of record.session.messages) for (const card of message.cards) {
      card.name = 'Корпоративная лицензия для распределённой инфраструктуры ' + 'ОченьДлинноеНазваниеБезПробелов'.repeat(4)
      card.attributes.platform = 'Windows / Linux / macOS · требует уточнения редакции'
    }
    localStorage.setItem(key, JSON.stringify(entries))
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate((el) => el.clientWidth))
  for (const selector of ['.conversation', '.offer-card', '.sources']) {
    expect(await page.locator(selector).first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('long-card.png'), fullPage: true })
})

test('compact composer grows, caps and shrinks with text and viewport changes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  const send = page.getByRole('button', { name: 'Отправить', exact: true })
  const row = page.locator('.composer-input')
  async function centered() {
    const [area, field, button] = await Promise.all([row.boundingBox(), input.boundingBox(), send.boundingBox()])
    expect(Math.abs((field!.y + field!.height / 2) - (area!.y + area!.height / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs((button!.y + button!.height / 2) - (area!.y + area!.height / 2))).toBeLessThanOrEqual(1)
  }
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(32)
  await centered()
  expect((await page.locator('.composer').boundingBox())!.height).toBeLessThan(110)
  const hitArea = await page.locator('.composer-text-area').boundingBox()
  for (const y of [2, hitArea!.height - 2]) {
    await input.evaluate((el) => el.blur())
    await page.mouse.click(hitArea!.x + hitArea!.width / 2, hitArea!.y + y)
    await expect(input).toBeFocused()
  }
  await input.evaluate((el) => el.blur())
  const surface = await page.locator('.composer').boundingBox()
  await page.mouse.click(surface!.x + 4, surface!.y + surface!.height / 2)
  await expect(input).toBeFocused()
  expect((await send.boundingBox())!.width).toBe(48)
  expect((await send.boundingBox())!.height).toBe(48)

  await input.fill(Array.from({ length: 20 }, (_, i) => `Строка ${i + 1}: описание требований`).join('\n'))
  await expect.poll(async () => (await input.boundingBox())!.height).toBe(160)
  await expect(input).toHaveCSS('overflow-y', 'auto')
  await centered()
  expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  await input.fill('')
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(32)
  await expect(input).toHaveCSS('overflow-y', 'hidden')
  await input.fill('Нужно подобрать программное обеспечение для нашей инфраструктуры. '.repeat(6))
  const before = (await input.boundingBox())!.height
  await page.setViewportSize({ width: 320, height: 568 })
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThanOrEqual(before)
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(160)
  await input.fill('Короткий вопрос')
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(32)
  await centered()
  expect((await send.boundingBox())!.width).toBe(48)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320)
  expect(errors).toEqual([])
})
