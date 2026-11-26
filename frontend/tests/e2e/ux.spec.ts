import { expect, test, type Page } from '@playwright/test'

async function recommendation(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await page.getByRole('button', { name: 'Подобрать решение', exact: true }).click()
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
}

async function replaceTexts(page: Page, userText: string, assistantText: string) {
  // Change only synthetic persisted message text, keeping real API-shaped cards/sources.
  await page.evaluate(({ userText, assistantText }) => {
    const id = localStorage.getItem('softline:mock:session')
    const entries = JSON.parse(localStorage.getItem('softline:mock:server') || '[]')
    const record = entries.find(([key]: [string]) => key === id)?.[1]
    if (!record) throw new Error('Demo session missing')
    for (const message of record.session.messages) message.text = message.role === 'user' ? userText : assistantText
    localStorage.setItem('softline:mock:server', JSON.stringify(entries))
  }, { userText, assistantText })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
}

test('text bubbles fit short replies, wrap long text and preserve card/source widths', async ({ page }, info) => {
  await recommendation(page)
  await replaceTexts(page, 'Да.', 'Подойдёт.')
  const user = page.getByRole('article', { name: 'Вы', exact: true })
  const assistant = page.getByRole('article', { name: 'Консультант', exact: true })
  expect((await user.locator('.message-content').boundingBox())!.width).toBeLessThan(150)
  expect((await assistant.locator('.message-body').boundingBox())!.width).toBeLessThan(200)
  const sizes = info.project.name === 'desktop' ? { offer: 440, sources: 720 } : { offer: 332, sources: 332 }
  // Measured before this UX change at the same project viewports.
  expect((await page.locator('.offer-card').boundingBox())!.width).toBeCloseTo(sizes.offer, 1)
  expect((await page.locator('.sources').boundingBox())!.width).toBeCloseTo(sizes.sources, 1)
  const positions = await Promise.all([user.locator('.message-content').boundingBox(), assistant.locator('.message-body').boundingBox()])
  expect(positions[0]!.x).toBeGreaterThan(positions[1]!.x)

  await replaceTexts(page, 'Описание инфраструктуры и условий лицензирования. '.repeat(30),
    'Пояснение по требованиям и подтверждённым данным. '.repeat(40) + '\n' + 'ДлинноеСловоБезПробелов'.repeat(30))
  for (const selector of ['.message-body', '.message-content', '.offer-card', '.sources']) {
    for (const element of await page.locator(`.conversation ${selector}`).all()) {
      expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    }
  }
  expect((await page.locator('.offer-card').boundingBox())!.width).toBeCloseTo(sizes.offer, 1)
  expect((await page.locator('.sources').boundingBox())!.width).toBeCloseTo(sizes.sources, 1)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate((node) => node.clientWidth))
})

test('icon-only jump stays outside history, hides at the end and follows viewport resize', async ({ page }) => {
  await recommendation(page)
  await replaceTexts(page, 'Подбор корпоративной лицензии. '.repeat(20), 'Сведения о вариантах и требованиях. '.repeat(40))
  const conversation = page.locator('.conversation')
  const jump = page.getByRole('button', { name: 'К последнему сообщению' })
  await expect(jump).toHaveCount(0)
  await conversation.evaluate((node) => { node.scrollTop = 0 })
  await expect(jump).toBeVisible()
  await expect(jump).toHaveText('')
  await expect(jump).toHaveAttribute('title', 'К последнему сообщению')
  await expect(jump).toHaveCSS('border-radius', '50%')
  await jump.evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => undefined))) })
  const [button, history, composer] = await Promise.all([jump.boundingBox(), conversation.boundingBox(), page.locator('.composer').boundingBox()])
  expect(button!.width).toBeCloseTo(button!.height, 2)
  expect(button!.width).toBeGreaterThanOrEqual(40)
  expect(button!.y).toBeGreaterThanOrEqual(history!.y + history!.height - 1)
  expect(button!.y + button!.height).toBeLessThanOrEqual(composer!.y)
  const inputY = composer!.y
  await jump.click()
  await expect(jump).toHaveCount(0)
  expect((await page.locator('.composer').boundingBox())!.y).toBeCloseTo(inputY, 1)
  expect(await conversation.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2)

  await conversation.evaluate((node) => { node.scrollTop = 0 })
  await expect(jump).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 4000 })
  await expect(jump).toHaveCount(0)
})
