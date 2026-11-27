import { expect, test, type Page } from '@playwright/test'

async function geometry(page: Page, selectors: string[]) {
  return page.evaluate((selectors) => selectors.map((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect()
    const style = getComputedStyle(document.querySelector(selector)!)
    return [box.x, box.y, box.width, box.height, style.fontSize, style.padding, style.borderRadius]
  }), selectors)
}

async function contrast(page: Page) {
  const ratios = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    const luminance = (token: string) => {
      const hex = css.getPropertyValue(token).trim().slice(1)
      const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
      return r * .2126 + g * .7152 + b * .0722
    }
    return [['--text', '--surface-card'], ['--muted', '--surface-muted'], ['--subtle', '--surface'], ['--accent', '--accent-soft'], ['--on-action', '--action'], ['--on-action', '--action-hover'], ['--warning', '--warning-soft'], ['--case-waiting-text', '--case-waiting-bg'], ['--case-progress-text', '--case-progress-bg'], ['--case-completed-text', '--case-completed-bg']].map(([a, b]) => {
      const x = luminance(a!), y = luminance(b!)
      return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
    })
  })
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)
}

test('themes preserve geometry, preference, official branding and client state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
  const selectors = ['.header', '.brand-image', '.main', '.workspace-bar', '.example-questions', '.composer', '.composer textarea']
  // Keep dimensions identical; color and image content are the only theme changes.
  const dark = await geometry(page, selectors)
  const input = page.getByRole('textbox', { name: 'Ваше сообщение' })
  await input.fill('Сохранённый черновик')
  await page.getByRole('button', { name: 'Включить светлую тему' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(input).toHaveValue('Сохранённый черновик')
  expect(await geometry(page, selectors)).toEqual(dark)
  await expect(page.getByRole('img', { name: 'Софтлайн РЕШЕНИЯ · SOFL' })).toHaveAttribute('src', /softline-solutions-sofl.*\.png/)
  await contrast(page)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await input.fill('Подобрать решение на 50 пользователей')
  await page.getByRole('button', { name: 'Отправить', exact: true }).click()
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Сформировать КП' })).toBeVisible()
  await page.locator('.conversation').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const chat = await geometry(page, ['.main', '.message-user .message-content', '.offer-card', '.sources', '.composer'])
  await page.getByRole('button', { name: 'Включить тёмную тему' }).click()
  expect(await geometry(page, ['.main', '.message-user .message-content', '.offer-card', '.sources', '.composer'])).toEqual(chat)
  await expect(page.getByRole('button', { name: 'Выбрано', exact: true })).toBeVisible()
  await contrast(page)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('article', { name: 'Вы', exact: true })).toHaveCount(1)
})

test('both manager palettes stay responsive, readable and respect reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/manager/DEMO-1024')
  await expect(page.locator('.case-detail')).toBeVisible()
  const dark = await geometry(page, ['.header', '.manager-layout', '.case-detail', '.requirements-grid', '.offer-card'])
  await page.getByRole('button', { name: 'Включить светлую тему' }).click()
  expect(await geometry(page, ['.header', '.manager-layout', '.case-detail', '.requirements-grid', '.offer-card'])).toEqual(dark)
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Включить тёмную тему' }).click()
    await contrast(page)
    await expect(page.locator('.case-detail')).toHaveCSS('animation-name', 'none')
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate((el) => el.clientWidth))
    await page.setViewportSize({ width: 320, height: 568 })
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320)
    await expect(page.getByRole('button', { name: /Включить .* тему/ })).toBeInViewport()
  }
})

for (const theme of ['light', 'dark'] as const) {
  test(`glass contrast and solid fallback in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Поможем найти/ })).toBeVisible()
    if (theme === 'light') await page.getByRole('button', { name: 'Включить светлую тему' }).click()
    const ratios = await page.evaluate(() => {
      const parse = (color: string) => color.match(/[\d.]+/g)!.map(Number)
      const luminance = (rgb: number[]) => {
        const c = rgb.map((value) => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
        return c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722
      }
      const light = document.documentElement.dataset.theme === 'light'
      const backings = light ? [[255, 255, 255], [245, 246, 248], [240, 222, 228]] : [[21, 20, 28], [33, 26, 37], [96, 48, 67]]
      return [['.header', '.header-nav a', ''], ['.main', '.welcome > p', ''], ['.composer', '.composer textarea', '::placeholder']].flatMap(([surface, text, pseudo]) => {
        const background = parse(getComputedStyle(document.querySelector(surface!)!).backgroundColor)
        const foreground = parse(getComputedStyle(document.querySelector(text!)!, pseudo || null).color)
        return backings.map((backing) => {
          const alpha = background[3] ?? 1
          const rgb = backing.map((value, i) => background[i]! * alpha + value * (1 - alpha))
          const a = luminance(foreground.slice(0, 3)), b = luminance(rgb)
          return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
        })
      })
    })
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)
    // Clear the toggle's hover state; its hover surface is intentionally also opaque.
    await page.locator('.workspace-title h1').click()
    const client = await page.context().newCDPSession(page)
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
    for (const selector of ['.header', '.main', '.composer', '.section-switch', '.theme-toggle']) {
      await expect(page.locator(selector)).toHaveCSS('background-color', theme === 'dark' ? 'rgb(28, 32, 42)' : 'rgb(255, 255, 255)')
      await expect(page.locator(selector)).toHaveCSS('backdrop-filter', 'none')
    }
  })
}
