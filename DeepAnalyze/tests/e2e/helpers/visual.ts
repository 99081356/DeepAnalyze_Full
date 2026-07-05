/**
 * Screenshot + VLM visual verification helpers.
 *
 * Screenshots are saved to tests/screenshots/<name>.png.
 * VLM analysis is optional and only used when explicitly requested.
 */
import { Page, expect } from "@playwright/test";
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const SCREENSHOT_DIR = resolve(__dirname, "..", "screenshots");

function ensureDir() {
  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

/**
 * Take a screenshot and save to disk.
 * Returns the file path for later analysis.
 */
export async function takeScreenshot(
  page: Page,
  name: string,
  options?: { selector?: string; fullPage?: boolean },
): Promise<string> {
  ensureDir();
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  if (options?.selector) {
    const el = page.locator(options.selector);
    await el.screenshot({ path }).catch(() =>
      page.screenshot({ path, fullPage: options?.fullPage ?? true }),
    );
  } else {
    await page.screenshot({ path, fullPage: options?.fullPage ?? true });
  }
  return path;
}

/**
 * Take a screenshot and verify basic expectations.
 * Uses DOM assertions — no VLM needed for most checks.
 */
export async function screenshotAndCheck(
  page: Page,
  name: string,
  expectations: Array<{
    type: "visible" | "text" | "count" | "url";
    selector?: string;
    value?: string | number | RegExp;
    timeout?: number;
  }>,
): Promise<string> {
  const path = await takeScreenshot(page, name);

  for (const exp of expectations) {
    switch (exp.type) {
      case "visible": {
        const locator = page.locator(exp.selector!);
        await expect(locator.first()).toBeVisible({ timeout: exp.timeout ?? 5000 });
        break;
      }
      case "text": {
        const locator = page.locator(exp.selector!);
        if (exp.value instanceof RegExp) {
          await expect(locator.first()).toHaveText(exp.value, { timeout: exp.timeout ?? 5000 });
        } else {
          await expect(locator.first()).toContainText(exp.value as string, { timeout: exp.timeout ?? 5000 });
        }
        break;
      }
      case "count": {
        const locator = page.locator(exp.selector!);
        await expect(locator).toHaveCount(exp.value as number, { timeout: exp.timeout ?? 5000 });
        break;
      }
      case "url": {
        await expect(page).toHaveURL(exp.value as RegExp, { timeout: exp.timeout ?? 5000 });
        break;
      }
    }
  }

  return path;
}

/**
 * Navigate to a hash route and wait for the page to settle.
 */
export async function gotoPage(page: Page, route: string): Promise<void> {
  await page.goto(`/#/${route}`);
  await page.waitForLoadState("networkidle");
  // Extra settle time for React rendering
  await page.waitForTimeout(500);
}

/**
 * Check that no critical console errors occurred during page load.
 * Returns the list of critical errors found.
 */
export async function checkConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

/**
 * Get filtered critical console errors (excludes known harmless messages).
 */
export function filterCriticalErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("net::ERR") &&
      !e.includes("404") &&
      !e.includes("Failed to fetch") &&
      !e.includes("NetworkError") &&
      !e.includes("WebSocket") &&
      !e.includes("ResizeObserver") &&
      !e.includes("Non-Error promise rejection"),
  );
}
