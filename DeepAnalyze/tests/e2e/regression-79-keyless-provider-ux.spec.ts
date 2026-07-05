// =============================================================================
// Regression #79: keyless provider experience polish
// =============================================================================
// Two assertions:
//   1. SystemStatusBanner: embedding_not_configured renders as WARNING (amber),
//      not CRITICAL (red). Only llm_not_configured stays red.
//   2. Settings → 模型配置 → Provider 管理 → 已配置 list: providers with
//      hasKey=false show a subtle "无 key" badge; providers with hasKey=true
//      render no extra badge (no visual noise).
//
// Mocking strategy: stub /api/health and /api/settings/providers so the test
// exercises the same frontend decision tree that real users see, without
// needing DB mutations.
// =============================================================================

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "tests/e2e/screenshots/regression-79";
mkdirSync(SHOTS, { recursive: true });

// Health payload with mixed key status — mirrors what backend returns after #77
const HEALTH_MIXED_KEYS = {
  status: "ok",
  version: "0.7.6",
  embedding: {
    status: "ok",
    provider: "local-bge-m3",
    dimension: 1024,
    degraded: false,
    cooldownRemainingMs: 0,
    mainProviderHasKey: true,
  },
  llm: {
    status: "ok",
    providerCount: 3,
    providers: ["glm-configured", "minimax-nokey-01", "minimax-nokey-02"],
    providersWithKey: [
      { id: "glm-configured", hasKey: true },
      { id: "minimax-nokey-01", hasKey: false },
      { id: "minimax-nokey-02", hasKey: false },
    ],
    mainModel: "glm-configured",
    mainModelHasKey: true,
  },
  pg: true,
};

const PROVIDERS_PAYLOAD = {
  providers: [
    {
      id: "glm-configured",
      name: "GLM-5.2",
      type: "openai-compatible",
      registryId: "glm",
      endpoint: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "sk-real-key",
      model: "glm-5.2",
      enabled: true,
    },
    {
      id: "minimax-nokey-01",
      name: "MiniMax-01",
      type: "openai-compatible",
      registryId: "minimax",
      endpoint: "https://api.minimax.chat/v1",
      apiKey: "",
      model: "MiniMax-M1",
      enabled: true,
    },
    {
      id: "minimax-nokey-02",
      name: "MiniMax-M2",
      type: "openai-compatible",
      registryId: "minimax",
      endpoint: "https://api.minimax.chat/v1",
      apiKey: "",
      model: "abab6.5s-chat",
      enabled: true,
    },
  ],
  defaults: { main: "glm-configured" },
};

test.describe("#79 keyless provider UX", () => {
  test("banner: embedding_not_configured is warning (amber), not critical (red)", async ({ page }) => {
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...HEALTH_MIXED_KEYS,
          embedding: {
            ...HEALTH_MIXED_KEYS.embedding,
            status: "not_configured",
            provider: "minimax-embedding",
            mainProviderHasKey: false,
          },
        }),
      });
    });

    await page.goto("/#/chat");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `${SHOTS}/01-banner-embedding-not-configured.png`,
      fullPage: true,
    });

    const banner = page.locator('[role="status"]').filter({
      hasText: "默认 embedding provider 缺 API key",
    });
    await expect(banner).toBeVisible();

    const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log(`[#79] embedding_not_configured banner bg=${bg}`);
    // amber-500 = rgb(245, 158, 11) = var(--warning). NOT red (239, 68, 68).
    expect(bg, "embedding_not_configured must be warning per #79").toContain("245, 158, 11");
    expect(bg, "embedding_not_configured must NOT be red per #79").not.toContain("239, 68, 68");
  });

  test("banner: llm_not_configured stays critical (red)", async ({ page }) => {
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...HEALTH_MIXED_KEYS,
          llm: { ...HEALTH_MIXED_KEYS.llm, status: "not_configured" },
        }),
      });
    });

    await page.goto("/#/chat");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    const banner = page.locator('[role="status"]').filter({
      hasText: "尚未配置任何 LLM provider",
    });
    await expect(banner).toBeVisible();

    const bg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log(`[#79] llm_not_configured banner bg=${bg}`);
    // red-500 = rgb(239, 68, 68) = var(--error). Stays critical.
    expect(bg, "llm_not_configured must stay critical (red)").toContain("239, 68, 68");
  });

  test("provider list: 无 key badge shows on missing-key providers only", async ({ page }) => {
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HEALTH_MIXED_KEYS),
      });
    });
    await page.route("**/api/settings/providers", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PROVIDERS_PAYLOAD),
      });
    });
    await page.route("**/api/settings/provider-registry", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await page.goto("/#/chat");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Open settings → 模型配置 tab is default
    await page.getByRole("button", { name: /设置/ }).first().click().catch(() => {});
    // Some layouts reveal settings via an icon button — try alternate selectors
    const settingsBtn = page.locator('button:has(svg.lucide-settings), [title*="设置"]').first();
    await settingsBtn.click().catch(() => {});

    await page.waitForTimeout(1000);

    await page.screenshot({
      path: `${SHOTS}/02-provider-list-badges.png`,
      fullPage: true,
    });

    // The "已配置" list shows three providers. Exactly two "无 key" badges should appear.
    const noKeyBadges = page.locator('span:has-text("无 key")');
    const badgeCount = await noKeyBadges.count();
    console.log(`[#79] 无 key badge count = ${badgeCount} (expected 2)`);
    expect(badgeCount, "exactly 2 providers should show 无 key badge").toBe(2);

    // The GLM provider (has key) should NOT have a badge next to it
    const glmRow = page.locator('text=GLM-5.2').locator('..');
    const glmBadge = glmRow.locator('span:has-text("无 key")');
    expect(await glmBadge.count(), "GLM (has key) must not show 无 key badge").toBe(0);
  });
});
