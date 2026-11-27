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
  const logo = page.getByRole('img', { name: 'Софтлайн РЕШЕНИЯ · SOFL' })
  await expect(logo).toBeVisible()
  expect(await logo.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(logo).toHaveAttribute('src', /softline-solutions-sofl-white\.svg/)
  const branding = await logo.evaluate((element) => {
    const image = element.getBoundingClientRect(), area = getComputedStyle(element.parentElement!)
    return { ratio: image.width / image.height, horizontalClear: parseFloat(area.paddingLeft) / image.height, verticalClear: parseFloat(area.paddingTop), filter: getComputedStyle(element).filter }
  })
  expect(branding.ratio).toBeCloseTo(524.41 / 115.4, 2)
  expect(branding.horizontalClear).toBeGreaterThanOrEqual(.99)
  expect(branding.verticalClear).toBeGreaterThanOrEqual(18)
  expect((await page.locator('.header').boundingBox())!.height).toBeLessThanOrEqual(testInfo.project.name === 'mobile' ? 63 : 69)
  expect(branding.filter).toBe('none')
  const examples = page.getByRole('list', { name: 'Примеры вопросов' })
  await expect(examples.getByRole('listitem')).toHaveText([
    'Какая лицензия MDaemon подойдёт для 50 пользователей?',
    'Как защитить почту и файлы 50 сотрудников?',
    'Какие документы нужны для покупки лицензии?',
  ])
  await expect(examples.locator('button, a, [tabindex]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('welcome.png'), fullPage: true, animations: 'disabled' })

  const ratios = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    function luminance(name: string) {
      const hex = css.getPropertyValue(name).trim().replace('#', '')
      const values = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
      return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722
    }
    return [['--text', '--surface'], ['--muted', '--surface-muted'], ['--accent', '--surface'], ['--warning', '--warning-soft'], ['--text', '--surface-card'], ['--muted', '--surface-card'], ['--success', '--surface-card'], ['--accent', '--accent-soft'], ['--on-action', '--action'], ['--on-action', '--action-hover'], ['--success', '--success-soft'], ['--muted', '--accent-soft'], ['--case-waiting-text', '--case-waiting-bg'], ['--case-progress-text', '--case-progress-bg']]
      .map(([a, b]) => { const x = luminance(a!), y = luminance(b!); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) })
  })
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)

  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Перейти к консультации' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  await expect(input).toHaveValue('')
  await input.fill('Мой вопрос')
  await examples.getByRole('listitem').first().click()
  await expect(input).toHaveValue('Мой вопрос')
  await expect(input).not.toBeFocused()

  await page.setViewportSize({ width: 320, height: 568 })
  await page.reload()
  await expect(heading).toBeInViewport()
  await expect(input).toBeInViewport()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320)
  await page.screenshot({ path: testInfo.outputPath('welcome-compact.png'), fullPage: true, animations: 'disabled' })
})

test('loading, error, sources and long card content retain their layout', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const input = page.getByRole('textbox')
  await input.fill('Ошибка модели')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('error.png'), fullPage: true, animations: 'disabled' })
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
  await page.screenshot({ path: testInfo.outputPath('long-card.png'), fullPage: true, animations: 'disabled' })
})

test('compact composer grows, caps and shrinks with text and viewport changes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  const send = page.getByRole('button', { name: 'Отправить', exact: true })
  const row = page.locator('.composer-input')
  await expect(page.locator('label[for="message"]')).toHaveClass('sr-only')
  await expect(input).toHaveAttribute('placeholder', /\?$/)
  async function centered() {
    const [area, field, button] = await Promise.all([row.boundingBox(), input.boundingBox(), send.boundingBox()])
    expect(Math.abs((field!.y + field!.height / 2) - (area!.y + area!.height / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs((button!.y + button!.height / 2) - (area!.y + area!.height / 2))).toBeLessThanOrEqual(1)
  }
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(32)
  await centered()
  expect((await page.locator('.composer').boundingBox())!.height).toBeLessThan(80)
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
  expect((await send.boundingBox())!.width).toBeCloseTo(48, 2)
  expect((await send.boundingBox())!.height).toBeCloseTo(48, 2)

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
  await expect(input).toHaveCSS('height', '160px')
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(160.5)
  await input.fill('Короткий вопрос')
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(32)
  await centered()
  expect((await send.boundingBox())!.width).toBeCloseTo(48, 2)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320)
  expect(errors).toEqual([])
})


test('chat text is comfortable to read and the composer does not cover the final reply', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await page.getByRole('textbox').fill('Подобрать решение на 50 пользователей')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  const user = page.getByRole('article', { name: 'Вы', exact: true })
  const assistant = page.getByRole('article', { name: 'Консультант', exact: true }).last()
  expect((await user.boundingBox())!.x).toBeGreaterThan((await assistant.boundingBox())!.x)
  for (const message of [user, assistant]) {
    await expect(message.locator('.message-body')).toHaveCSS('font-size', '16px')
    const metrics = await message.evaluate((element) => {
      const body = getComputedStyle(element.querySelector('.message-body')!)
      const author = getComputedStyle(element.querySelector('.message-author')!)
      return { size: parseFloat(body.fontSize), line: parseFloat(body.lineHeight), author: parseFloat(author.fontSize), text: body.color, secondary: author.color }
    })
    expect(metrics.line / metrics.size).toBeGreaterThanOrEqual(1.6)
    expect(metrics.line / metrics.size).toBeLessThanOrEqual(1.8)
    expect(metrics.author).toBeGreaterThanOrEqual(12)
    expect(metrics.author).toBeLessThan(metrics.size)
  }
  await expect(assistant.locator('.ai-tag')).toHaveText('AI')
  const scroll = page.locator('.conversation')
  await scroll.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)))
    element.scrollTop = element.scrollHeight
  })
  const [reply, viewport, composer] = await Promise.all([assistant.boundingBox(), scroll.boundingBox(), page.locator('.composer').boundingBox()])
  expect(reply!.y + reply!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1)
  expect(viewport!.y + viewport!.height).toBeLessThanOrEqual(composer!.y + 1)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate((element) => element.clientWidth))
})
