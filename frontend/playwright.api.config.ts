import { defineConfig } from '@playwright/test'
const baseURL = 'http://127.0.0.1:5185'
export default defineConfig({
  testDir: './tests/api-browser', outputDir: './test-results-api', workers: 1, retries: 0, reporter: 'list',
  use: { baseURL, channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure', reducedMotion: 'reduce' },
  projects: [
    { name: 'api-desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'api-mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'pnpm dev --port 5185', url: baseURL, reuseExistingServer: false },
})
