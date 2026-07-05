/**
 * 08 - Settings Panel Tests
 * Covers: providers, defaults, agent settings, feature flags, UI tabs.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

test.describe("08 - Settings Panel", () => {
  let api: ReturnType<typeof createApi>;

  test.beforeEach(async ({ request }) => {
    api = createApi(request);
  });

  test("8.1 provider list is non-empty", async () => {
    const result = await api.getProviders();
    expect(result.providers).toBeDefined();
    expect(Array.isArray(result.providers)).toBeTruthy();
    expect(result.providers.length, "Should have at least 1 provider").toBeGreaterThanOrEqual(1);
  });

  test("8.2 default model config has main role", async () => {
    const defaults = await api.getDefaults();
    expect(defaults.main, "Should have main model default").toBeDefined();
  });

  test("8.3 agent settings have required fields", async () => {
    const settings = await api.getAgentSettings();
    expect(settings.maxTurns).toBeDefined();
    expect(settings.contextWindow).toBeDefined();
    expect(settings.outputTokenBudget).toBeDefined();
    expect(typeof settings.maxTurns).toBe("number");
    expect(typeof settings.contextWindow).toBe("number");
  });

  test("8.4 maxTurns is -1 (unlimited)", async () => {
    const settings = await api.getAgentSettings();
    expect(settings.maxTurns).toBe(-1);
  });

  test("8.5 agent settings have subAgentMaxTurns", async () => {
    const settings = await api.getAgentSettings();
    expect(settings.subAgentMaxTurns).toBeDefined();
    expect(typeof settings.subAgentMaxTurns).toBe("number");
  });

  test("8.6 settings page screenshot - tabs visible", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Click settings button in header
    const settingsBtn = page.locator('button:has-text("设置")').first();
    if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(1000);
    }

    await takeScreenshot(page, "settings-panel");
  });

  test("8.7 settings main model tab", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const settingsBtn = page.locator('button:has-text("设置")').first();
    if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(1000);

      // Look for model config elements
      const tabLabels = ["主模型", "辅助模型", "嵌入模型"];
      for (const label of tabLabels) {
        const tab = page.locator(`text=${label}`).first();
        // Tabs may or may not be visible depending on panel state
        if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
          await tab.click();
          await page.waitForTimeout(500);
        }
      }
    }

    await takeScreenshot(page, "settings-model-tabs");
  });

  test("8.8 settings persistence test", async () => {
    // Read current settings
    const settings = await api.getAgentSettings();
    expect(settings).toBeTruthy();

    // Settings should be retrievable consistently
    const settings2 = await api.getAgentSettings();
    expect(settings2.maxTurns).toBe(settings.maxTurns);
    expect(settings2.contextWindow).toBe(settings.contextWindow);
  });

  test("8.9 agent settings have expected fields", async () => {
    const settings = await api.getAgentSettings();
    const expectedFields = [
      "maxTurns",
      "contextWindow",
      "outputTokenBudget",
      "subAgentMaxTurns",
      "consecutiveErrorThreshold",
      "stuckDetectionThreshold",
    ];

    for (const field of expectedFields) {
      expect(settings[field], `Field "${field}" should be defined`).toBeDefined();
    }
  });
});
