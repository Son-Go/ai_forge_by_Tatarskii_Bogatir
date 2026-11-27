import { expect, test } from '@playwright/test'

test('FAQ UI supports review, retry, publication and withdrawal without a fabricated API', async ({ page }, info) => {
  const api: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()) })
  await page.goto('/tests/fixtures/faq-review.html')
  const panel = page.getByRole('region', { name: 'Ответ для FAQ' })
  await expect(panel).toBeVisible()
  const question = panel.getByRole('textbox', { name: 'Вопрос для FAQ' })
  const answer = panel.getByRole('textbox', { name: 'Ответ для FAQ' })
  const publish = panel.getByRole('button', { name: 'Опубликовать в FAQ' })
  await question.fill('Исправленный общий вопрос')
  await answer.fill('Исправленный общий ответ, подтверждённый тестовым источником.')
  await expect(publish).toBeDisabled()
  await panel.getByRole('checkbox').check()
  await page.getByRole('checkbox', { name: 'Следующее действие завершится ошибкой' }).check()
  await publish.click()
  await expect(publish).toBeDisabled()
  await expect(question).toBeDisabled()
  await expect(panel.getByRole('alert')).toContainText('Тестовый сетевой сбой')
  await expect(question).toHaveValue('Исправленный общий вопрос')
  await expect(answer).toHaveValue('Исправленный общий ответ, подтверждённый тестовым источником.')
  await expect(page.getByTestId('operations')).toHaveText('1')
  await publish.click()
  await expect(panel.getByRole('status', { name: 'Статус проверки FAQ' })).toHaveText('В FAQ')
  await expect(panel.getByText('Исправленный общий вопрос', { exact: true })).toBeVisible()
  await expect(panel.getByRole('link')).toHaveAttribute('href', 'https://example.com/support/faq')
  await panel.getByRole('button', { name: 'Снять с публикации' }).click()
  await expect(panel.getByRole('button', { name: 'Снять с публикации' })).toBeDisabled()
  await expect(panel.getByRole('textbox', { name: 'Вопрос для FAQ' })).toHaveValue('Исправленный общий вопрос')
  await panel.getByRole('button', { name: 'Отклонить', exact: true }).click()
  await expect(panel.getByRole('status', { name: 'Статус проверки FAQ' })).toHaveText('Отклонено')
  for (const label of ['В очереди', 'Ответ по заказу', 'В FAQ', 'Нужна проверка']) {
    await page.getByRole('combobox', { name: 'Состояние UI' }).selectOption(label)
    await expect(panel.getByRole('status', { name: 'Статус проверки FAQ' })).toHaveText(label)
  }
  await expect(page.getByTestId('operations')).toHaveText('4')
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Сменить тему' }).click()
      await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width)
      await expect(panel).toHaveCSS('animation-name', 'none')
      await expect(panel.getByRole('textbox', { name: 'Ответ для FAQ' })).toHaveCSS('font-size', '16px')
      const bounds = await panel.boundingBox(), sourceBounds = await panel.locator('.sources').boundingBox()
      expect(sourceBounds!.x).toBeGreaterThanOrEqual(bounds!.x + 16)
      expect(sourceBounds!.x + sourceBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width - 16)
      if (width !== 320 && info.project.name === 'api-desktop') {
        await panel.screenshot({ path: info.outputPath(`faq-review-${theme}-${width}.png`), animations: 'disabled' })
      }
    }
  }
  expect(api).toEqual([])
  await page.screenshot({ path: info.outputPath('faq-review-light.png'), fullPage: true, animations: 'disabled' })
})
