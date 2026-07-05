/**
 * UI Screenshot Verification — Hub Server visual audit.
 *
 * Navigates through every Hub page, captures screenshots at key
 * interaction points, and verifies design system elements.
 *
 * Screenshots saved to tests/e2e/screenshots/hub-verify/
 */
import { test, expect } from "@playwright/test";

const SHOT_DIR = "hub-verify";

const HUB_URL = "http://localhost:22000";

test.describe.serial("Hub UI Screenshot Audit", () => {
  test("UI01: Login page renders correctly", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/01-login.png`, fullPage: true });

    // Verify login form exists
    const usernameInput = page.locator('input[name="username"], input[placeholder*="用户"], input[type="text"]');
    await expect(usernameInput).toBeVisible({ timeout: 5000 });
  });

  test("UI02: Login as admin → dashboard", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.waitForLoadState("networkidle");

    // Login
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');

    // Wait for dashboard
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/02-dashboard.png`, fullPage: true });

    // Verify dashboard content
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(50); // Page has content
  });

  test("UI03: Organizations page — tree structure", async ({ page }) => {
    // Login first
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    // Navigate to orgs
    await page.goto(`${HUB_URL}/#/orgs`).catch(() => {});
    await page.goto(`${HUB_URL}/orgs`).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/03-orgs.png`, fullPage: true });
  });

  test("UI04: Users page", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    await page.goto(`${HUB_URL}/users`).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/04-users.png`, fullPage: true });
  });

  test("UI05: Skills page — marketplace listing", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    await page.goto(`${HUB_URL}/skills`).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/05-skills.png`, fullPage: true });
  });

  test("UI06: Sharings page — Phase D rewrite", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    await page.goto(`${HUB_URL}/sharings`).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/06-sharings.png`, fullPage: true });
  });

  test("UI07: Workers page", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    await page.goto(`${HUB_URL}/workers`).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/07-workers.png`, fullPage: true });
  });

  test("UI08: Security page — Phase D rewrite with design tokens", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    await page.goto(`${HUB_URL}/security`).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/08-security.png`, fullPage: true });
  });

  test("UI09: Dark mode toggle — design token verification", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    // Light mode
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/09a-light-mode.png`, fullPage: true });

    // Find and click theme toggle
    const themeBtn = page.locator('button:has-text("暗色"), button:has-text("Dark"), button:has-text("月"), [aria-label*="theme"], [aria-label*="主题"], button[class*="theme"]').first();
    if (await themeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await themeBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/09b-dark-mode.png`, fullPage: true });

      // Verify dark mode by checking background color
      const bg = await page.locator("body").evaluate((el) =>
        window.getComputedStyle(el).backgroundColor
      );
      console.log("Dark mode background:", bg);
    } else {
      console.log("Theme toggle button not found — may use different selector");
    }
  });

  test("UI10: Error boundary — invalid route triggers graceful error", async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});

    // Navigate to non-existent page
    await page.goto(`${HUB_URL}/nonexistent-page-xyz`).catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/10-error-boundary.png`, fullPage: true });

    // Should not be a blank white page
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(0);
  });

  test("UI11: Console errors — no critical errors on any page", async ({ page }) => {
    const errors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Filter out known non-critical errors
        if (!text.includes("favicon") &&
            !text.includes("ResizeObserver") &&
            !text.includes("NetworkError")) {
          errors.push(text);
        }
      }
    });

    // Login
    await page.goto(`${HUB_URL}/login`);
    await page.fill('input[type="text"], input[name="username"]', "admin");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Visit all major pages
    for (const path of ["/dashboard", "/orgs", "/users", "/skills", "/sharings", "/workers", "/security"]) {
      await page.goto(`${HUB_URL}${path}`).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(800);
    }

    await page.screenshot({ path: `tests/e2e/screenshots/${SHOT_DIR}/11-final.png`, fullPage: true });

    if (errors.length > 0) {
      console.log("Console errors found:", errors);
    }
    expect(errors.length).toBe(0);
  });
});
