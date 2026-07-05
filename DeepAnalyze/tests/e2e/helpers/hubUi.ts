/**
 * Hub frontend (admin console) UI helpers.
 *
 * The Hub SPA at http://localhost:22000/ gates on a localStorage
 * "hub_access_token". These helpers inject the token and navigate,
 * so tests can screenshot real admin pages.
 */
import { Page } from "@playwright/test";
import { HUB_BASE, shot } from "./hubApi";

/** Open the Hub SPA authenticated as the given JWT bearer token. */
export async function openHub(page: Page, token: string, path = "/"): Promise<void> {
  // Visit once to set origin for localStorage, then inject token.
  await page.goto(`${HUB_BASE}/login`);
  await page.evaluate((t) => localStorage.setItem("hub_access_token", t), token);
  await page.goto(`${HUB_BASE}${path}`);
  // Wait for the SPA shell to render (header or loading text).
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Login via the UI (exercises the real login form). Returns after dashboard renders. */
export async function loginHubUI(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${HUB_BASE}/login`);
  await page.fill('input[placeholder*="用户名"], input[name="username"]', username).catch(async () => {
    await page.fill("input", username);
  });
  const inputs = await page.locator('input[type="password"], input').all();
  for (const inp of inputs) {
    if (await inp.getAttribute("type") === "password" || (await inp.inputValue()) === username) {
      // skip
    }
  }
  await page.fill('input[type="password"]', password).catch(async () => {
    const all = page.locator("input");
    const n = await all.count();
    if (n >= 2) await all.nth(1).fill(password);
  });
  await page.click('button:has-text("登录"), button[type="submit"]').catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Screenshot the current Hub page. Thin wrapper around shot(). */
export async function hubShot(page: Page, name: string, fullPage = true): Promise<string> {
  return shot(page, name, fullPage);
}
