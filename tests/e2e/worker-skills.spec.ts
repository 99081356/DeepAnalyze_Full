/**
 * WorkerSkills page spec — tabs, search, empty state, card fields, source badge.
 *
 * W1: Default tab = pending; tab click switches content
 * W2: Search filters results (300ms debounce)
 * W3: Empty state shows "暂无 skill" when search returns nothing
 * W4: SkillAdminCard renders all fields
 * W5: "🔗 源自企业包" badge appears ONLY when source_package_id set
 */

import { test, expect } from "./fixtures.js";
import {
  loginFast,
  captureScreenshot,
  seedMarketplaceSkill,
  cleanupTestSkills,
  cardByName,
} from "./fixtures.js";

test.describe("WorkerSkills page", () => {
  test.beforeEach(async ({ page, request, cleanup }) => {
    await loginFast(page, request, "admin", "admin123");
    await cleanup();
  });

  test.afterEach(async ({ cleanup }) => {
    await cleanup();
  });

  test("W1: default tab is pending; tab click switches content", async ({ page }) => {
    // Seed: 1 pending + 1 approved
    const pending = await seedMarketplaceSkill("pending", { name: "TestPending W1" });
    const approved = await seedMarketplaceSkill("approved", { name: "TestApproved W1" });

    await page.goto("/worker-skills", { waitUntil: "networkidle" });

    // Default = pending → should see TestPending, not TestApproved
    await expect(page.getByText("TestPending W1")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("TestApproved W1")).not.toBeVisible();

    // Click 已批准 tab → should see TestApproved, not TestPending
    await page.getByRole("button", { name: /^已批准/ }).click();
    await expect(page.getByText("TestApproved W1")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("TestPending W1")).not.toBeVisible();

    await captureScreenshot(page, "worker-skills", "w1-tab-switch");
  });

  test("W2: search filters results after debounce", async ({ page }) => {
    await seedMarketplaceSkill("pending", { name: "AlphaUnique SearchTest", slug: "test-alpha-search" });
    await seedMarketplaceSkill("pending", { name: "BetaDifferent SearchTest", slug: "test-beta-search" });

    await page.goto("/worker-skills", { waitUntil: "networkidle" });
    await expect(page.getByText("AlphaUnique SearchTest")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("BetaDifferent SearchTest")).toBeVisible();

    // Type search — should filter after 300ms debounce + network
    await page.getByPlaceholder("搜索 name / slug / description").fill("AlphaUnique");
    // Wait well past debounce
    await page.waitForTimeout(700);

    await expect(page.getByText("AlphaUnique SearchTest")).toBeVisible();
    await expect(page.getByText("BetaDifferent SearchTest")).not.toBeVisible();

    await captureScreenshot(page, "worker-skills", "w2-search-filter");
  });

  test("W3: empty state shows '暂无 skill' when no match", async ({ page }) => {
    await page.goto("/worker-skills", { waitUntil: "networkidle" });

    // Type a search that matches nothing
    await page.getByPlaceholder("搜索 name / slug / description").fill("zzz-nothing-matches-xyz");
    await page.waitForTimeout(700);

    await expect(page.getByText("暂无 skill")).toBeVisible();
    await captureScreenshot(page, "worker-skills", "w3-empty-state");
  });

  test("W4: SkillAdminCard renders all fields", async ({ page }) => {
    await seedMarketplaceSkill("pending", {
      name: "TestCard W4",
      description: "W4 test description",
      prompt: "You are a W4 test assistant.",
      tags: ["w4-tag", "e2e"],
      version: "2.5.1",
    });

    await page.goto("/worker-skills", { waitUntil: "networkidle" });
    await expect(page.getByText("TestCard W4")).toBeVisible({ timeout: 5_000 });

    await captureScreenshot(page, "worker-skills", "w4-full-card");

    // Verify presence of key card fields
    await expect(page.getByText("TestCard W4")).toBeVisible();
    await expect(page.getByText("W4 test description")).toBeVisible();
    await expect(page.getByText("You are a W4 test assistant.")).toBeVisible();
    await expect(page.getByText("w4-tag", { exact: false })).toBeVisible();
    await expect(page.getByText(/v2\.5\.1/)).toBeVisible();
    // Action buttons for pending
    await expect(page.getByRole("button", { name: "批准" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "拒绝" }).first()).toBeVisible();
  });

  test("W5: '🔗 源自企业包' badge appears ONLY when source_package_id is set", async ({ page }) => {
    // Native submit (no source)
    await seedMarketplaceSkill("pending", {
      name: "TestNative W5",
      source_package_id: null,
    });
    // Promoted (with source) — use unique IDs to scope assertions
    await seedMarketplaceSkill("approved", {
      name: "TestPromoted W5",
      source_package_id: "fake-pkg-id-w5-0001",
      source_version_id: "fake-ver-id-w5-0001",
    });

    await page.goto("/worker-skills", { waitUntil: "networkidle" });

    // Approved tab — promoted badge visible INSIDE the TestPromoted W5 card
    await page.getByRole("button", { name: /^已批准/ }).click();
    await expect(page.getByText("TestPromoted W5")).toBeVisible({ timeout: 5_000 });
    await expect(
      cardByName(page, "TestPromoted W5").getByText("🔗 源自企业包")
    ).toBeVisible();

    // Switch to pending — native card should NOT have badge inside it
    await page.getByRole("button", { name: /^待审核/ }).click();
    await expect(page.getByText("TestNative W5")).toBeVisible({ timeout: 5_000 });
    await expect(
      cardByName(page, "TestNative W5").getByText("🔗 源自企业包")
    ).toHaveCount(0);

    await captureScreenshot(page, "worker-skills", "w5-source-badge");
  });
});
