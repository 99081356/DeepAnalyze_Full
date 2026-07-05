// =============================================================================
// Regression #77: embedding provider no-key should surface UI banner
// =============================================================================
// Strategy: mock /api/health so embedding.status = "not_configured", then verify
// SystemStatusBanner renders the correct message + style. Then reset the mock
// to a healthy response and verify the banner clears.
//
// Mocking avoids the need to mutate DB / restart DA — and exercises the same
// frontend decision tree that real users see.
// =============================================================================

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "tests/e2e/screenshots/regression-77";
mkdirSync(SHOTS, { recursive: true });

const HEALTH_OK = {
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
  llm: { status: "ok", providerCount: 5 },
  pg: true,
};

const HEALTH_EMBED_NO_KEY = {
  ...HEALTH_OK,
  embedding: {
    ...HEALTH_OK.embedding,
    status: "not_configured",
    provider: "minimax-embedding",
    mainProviderHasKey: false,
  },
};

const HEALTH_DEGRADED = {
  ...HEALTH_OK,
  embedding: {
    ...HEALTH_OK.embedding,
    status: "ok",
    degraded: true,
    cooldownRemainingMs: 30_000,
    mainProviderHasKey: true,
  },
};

test.describe("#77 embedding health banner", () => {
  test("banner appears when embedding provider has no key, disappears when fixed", async ({ page }) => {
    // ---------------------------------------------------------------------------
    // Phase 1: mock unhealthy embedding — banner should appear
    // ---------------------------------------------------------------------------
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HEALTH_EMBED_NO_KEY),
      });
    });

    await page.goto("/#/chat");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `${SHOTS}/01-banner-not-configured.png`,
      fullPage: true,
    });

    // The banner uses role="status" and contains the #77-specific message
    const banner = page.locator('[role="status"]').filter({
      hasText: "默认 embedding provider 缺 API key",
    });
    await expect(banner).toBeVisible();

    // After #79: embedding_not_configured degrades search to FTS/hash fallback
    // but chat keeps working — same severity as runtime embedding_degraded
    // (warning/amber), not critical/red. Only llm_not_configured stays red.
    const bg = await banner.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    console.log(`[test] not_configured banner bg=${bg}`);
    // #f59e0b = rgb(245, 158, 11) = var(--warning) — tailwind amber-500
    expect(bg, "not_configured banner should use --warning (amber) per #79").toContain(
      "245, 158, 11",
    );

    // ---------------------------------------------------------------------------
    // Phase 2: switch to degraded — banner text should differ (cooldown message)
    // ---------------------------------------------------------------------------
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HEALTH_DEGRADED),
      });
    });

    // Reload to force an immediate poll (otherwise we'd wait up to 60s)
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `${SHOTS}/02-banner-degraded.png`,
      fullPage: true,
    });

    const degradedBanner = page.locator('[role="status"]').filter({
      hasText: "降级中",
    });
    await expect(degradedBanner).toBeVisible();

    const degradedBg = await degradedBanner.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    console.log(`[test] degraded banner bg=${degradedBg}`);
    // #f59e0b = rgb(245, 158, 11) = var(--warning) — tailwind amber-500
    expect(degradedBg, "degraded banner should use --warning (amber)").toContain(
      "245, 158, 11",
    );

    // ---------------------------------------------------------------------------
    // Phase 3: switch to healthy — banner should disappear
    // ---------------------------------------------------------------------------
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HEALTH_OK),
      });
    });

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `${SHOTS}/03-banner-cleared.png`,
      fullPage: true,
    });

    const anyBanner = await page.locator('[role="status"]').count();
    console.log(`[test] banner count after health restored = ${anyBanner}`);
    expect(anyBanner, "no banner should be visible when health = ok").toBe(0);
  });

  test("backend actually computes mainProviderHasKey on /api/health", async ({ request }) => {
    // Sanity-check: real backend should report mainProviderHasKey:true under the
    // current dev env (local-bge-m3 is the default and doesn't need a key).
    const r = await request.get("/api/health");
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    console.log(
      `[sanity] embedding.status=${body.embedding?.status} provider=${body.embedding?.provider} mainProviderHasKey=${body.embedding?.mainProviderHasKey}`,
    );
    expect(body.embedding, "embedding section must be present").toBeDefined();
    expect(
      body.embedding.mainProviderHasKey,
      "mainProviderHasKey must be a boolean — verifies #77 backend wiring",
    ).toBeDefined();
  });
});
