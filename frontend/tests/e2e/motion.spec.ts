import { expect, test } from '@playwright/test'

test('message motion runs once during SSE and preserves drafting and scroll', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await page.evaluate(() => {
    const root = document.documentElement
    root.dataset.mockSseStepped = 'true'
    root.dataset.streamEntries = '0'
    document.addEventListener('animationstart', (event) => {
      if (event.animationName === 'message-enter' && event.target instanceof Element
        && event.target.matches('.message[aria-label="Ответ формируется"]')) {
        root.dataset.streamEntries = String(Number(root.dataset.streamEntries) + 1)
      }
    })
  })
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  await input.fill('Подобрать решение на 50 сотрудников')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await input.fill('Черновик следующего вопроса')
  const streamBody = page.getByRole('article', { name: 'Ответ формируется' }).locator('.message-body')
  await expect(streamBody).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-stream-entries', '1')
  const firstBlock = await streamBody.innerText()
  expect(firstBlock.length).toBeGreaterThan(0)
  await page.evaluate(() => window.dispatchEvent(new Event('softline:mock-next-delta')))
  await expect.poll(async () => (await streamBody.innerText()).length).toBeGreaterThan(firstBlock.length)
  await expect(streamBody).toContainText(firstBlock)
  await expect(page.locator('html')).toHaveAttribute('data-stream-entries', '1')
  await page.evaluate(() => window.dispatchEvent(new Event('softline:mock-next-delta')))
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('Черновик следующего вопроса')
  await expect(input).toBeFocused()
  await expect(page.locator('html')).toHaveAttribute('data-stream-entries', '1')
  await expect(page.getByRole('article', { name: 'Вы', exact: true })).toHaveCount(1)

  const conversation = page.locator('.conversation')
  await conversation.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true })
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => undefined)))
    el.scrollTop = 0
  })
  await expect(page.getByRole('button', { name: 'К последнему сообщению' })).toBeVisible()
  await page.getByRole('button', { name: 'К последнему сообщению' }).evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)))
  })
  expect(await conversation.evaluate((el) => el.scrollTop)).toBe(0)
  await page.getByRole('button', { name: 'К последнему сообщению' }).click()
  await expect.poll(() => conversation.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await expect(input).toHaveValue('Черновик следующего вопроса')
})

test('reduced motion disables entry, waiting and hover motion without hiding content', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await expect(page.locator('.example-questions')).toHaveCSS('transition-duration', '0s')
  await page.getByRole('textbox').fill('Подобрать решение на 50 пользователей')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await expect(page.locator('.spinner')).toHaveCSS('animation-name', 'none')
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  for (const selector of ['.message-assistant', '.offer-card', '.sources']) {
    await expect(page.locator(selector).first()).toHaveCSS('animation-name', 'none')
    await expect(page.locator(selector).first()).toHaveCSS('opacity', '1')
  }
  expect(await page.locator('.conversation').evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0)
})

test('reading cards stay opaque and glass has a solid fallback', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  await expect(page.locator('.example-questions')).toHaveCSS('background-color', 'rgb(41, 42, 49)')
  const glass = await page.locator('.header').evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      supported: CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'),
      filter: style.getPropertyValue('backdrop-filter') || style.getPropertyValue('-webkit-backdrop-filter'),
      background: style.backgroundColor,
    }
  })
  if (glass.supported) expect(glass.filter).toContain('blur(')
  else expect(glass.background).toBe('rgb(28, 32, 42)')
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
  for (const selector of ['.header', '.main', '.composer']) {
    await expect(page.locator(selector)).toHaveCSS('background-color', 'rgb(28, 32, 42)')
    await expect(page.locator(selector)).toHaveCSS('backdrop-filter', 'none')
  }
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate((el) => el.clientWidth))
})

test('glass keeps text contrast across the burgundy background and manager respects reduced motion', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const contrast = await page.evaluate(() => {
    const parse = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const luminance = (rgb: number[]) => {
      const c = rgb.map((value) => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
      return c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722
    }
    // Conservative dark backings covering both graphite endpoints and the warmer glow.
    const backings = [[21, 20, 28], [33, 26, 37], [96, 48, 67]]
    const samples = [
      ['.header', '.header-nav a', ''], ['.main', '.welcome > p', ''],
      ['.composer', '.composer textarea', '::placeholder'],
    ]
    return samples.flatMap(([surface, text, pseudo]) => {
      const background = parse(getComputedStyle(document.querySelector(surface!)!).backgroundColor)
      const foreground = parse(getComputedStyle(document.querySelector(text!)!, pseudo || null).color)
      const alpha = background[3] ?? 1
      return backings.map((backing) => {
        const rgb = backing.map((value, index) => background[index]! * alpha + value * (1 - alpha))
        const a = luminance(foreground.slice(0, 3)), b = luminance(rgb)
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      })
    })
  })
  for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('link', { name: 'Менеджер', exact: true }).click()
  await expect(page.locator('.manager-main')).toHaveCSS('animation-name', 'none')
  await page.getByRole('link', { name: /DEMO-1024/ }).click()
  await expect(page.locator('.case-detail')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.case-detail')).toHaveCSS('opacity', '1')
  await expect(page.locator('.case-detail .offer-card')).toHaveCSS('background-color', 'rgb(41, 42, 49)')
})
