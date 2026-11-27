import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const resolvePlaywright = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { chromium, expect } = resolvePlaywright("@playwright/test");
const baseURL = process.env.PANEL_TEST_ORIGIN ?? "http://127.0.0.1:18765";
const screenshots = process.env.PANEL_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PANEL_CHROME_BIN });
try {
  const context = await browser.newContext({
    baseURL,
    httpCredentials: { username: "operator", password: "operator-password-for-local-tests" },
    viewport: { width: 1300, height: 950 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await expect(page.locator("#ready")).toHaveText("1");
  await expect(page.locator("#problem")).toHaveText("2");
  await expect(page.locator("#charts canvas")).toHaveCount(4);
  await expect(page.getByText(/Свежих точек нет/).first()).toBeVisible();
  await expect(page.getByText(/не вернул значения/)).toBeVisible();
  await page.getByRole("button", { name: "Проверить ответ" }).click();
  await expect(page.locator("#probe-result")).toContainText(/OK.*мс/);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, "overview.png"), fullPage: true });

  await page.getByRole("link", { name: "Воркеры", exact: true }).click();
  const active = page.getByLabel("Активные воркеры").first();
  await expect(active).toHaveValue("0");
  await active.fill("4");
  await page.getByRole("button", { name: "Проверить изменения" }).click();
  await expect(page.locator("#write-status")).toContainText("превышает максимум");
  await page.getByRole("button", { name: "Загрузить текущие значения" }).click();
  await expect(active).toHaveValue("0");
  await page.getByRole("button", { name: "Держать воркер включённым 2 часа" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/3,50/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Применить в Runpod" }).click();
  await expect(page.locator("#timer-status")).toContainText("Автоматический возврат в");
  await page.getByRole("button", { name: "Готовность с запасом" }).click();
  await expect(dialog).toContainText("отменит автоматический возврат");
  await dialog.getByRole("button", { name: "Применить в Runpod" }).click();
  await expect(page.locator("#timer-status")).toHaveText("Таймер выключен.");
  await expect(page.locator("#write-status")).toContainText("Runpod подтвердил");

  await page.getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("heading", { name: "Workers", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Workers", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("HF_TOKEN", { exact: true })).toBeVisible();
  await expect(page.getByText("never-show-this-secret")).toHaveCount(0);
  await page.getByLabel("Docker image").fill("test/model:v2");
  await page.getByRole("button", { name: "Review changes" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("test/model:v1")).toBeVisible();
  await expect(dialog.getByText("test/model:v2")).toBeVisible();
  await expect(dialog.getByText(/can roll out workers/)).toBeVisible();
  if (screenshots) await page.screenshot({ path: path.join(screenshots, "confirmation.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Reload current values" }).click();
  await expect(page.getByLabel("Docker image")).toHaveValue("test/model:v1");

  await page.getByRole("link", { name: "Costs" }).click();
  await expect(page.getByText("$42.18")).toBeVisible();
  const daily = page.locator("#daily-costs");
  await expect(daily.getByRole("row")).toHaveCount(31);
  await expect(daily.getByText("Unavailable").first()).toBeVisible();
  await page.getByLabel("Period").selectOption("week");
  await expect(daily.getByRole("row")).toHaveCount(8);
  await page.getByLabel("Period").selectOption("today");
  await expect(daily.getByRole("row")).toHaveCount(2);
  await expect(daily.getByText("$1.23")).toBeVisible();
  await expect(page.getByRole("link", { name: /Token usage in Grafana/ })).toHaveAttribute(
    "href", /\/d\/runpod-token-usage$/,
  );
  await page.route("**/api/costs", (route) => route.fulfill({
    status: 502, contentType: "application/json", body: '{"error":"provider_unreachable"}',
  }));
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(daily.getByText("Could not reach Runpod.")).toBeVisible();
  await page.unroute("**/api/costs");
  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByRole("button", { name: "RU" }).click();
  await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.getByRole("heading", { name: "Расходы", exact: true })).toBeVisible();
  await expect(daily.getByRole("row")).toHaveCount(2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (screenshots) await page.screenshot({ path: path.join(screenshots, "costs-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Panel browser smoke passed");
} finally {
  await browser.close();
}
